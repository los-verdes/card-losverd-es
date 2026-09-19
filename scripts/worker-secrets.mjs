// Worker secrets are kept in 1Password (the source of truth) and pushed to
// Cloudflare from there -- Cloudflare never hands a secret's value back, so
// anything only stored there can't be recovered. See the `secrets-push` and
// `secrets-status` recipes in the justfile.
//
// 1Password layout: one item per environment in the "Los Verdes" vault, named
// `lv-card-losverd-es-worker-<env>` (a Secure Note works well), with one field
// per secret whose label is exactly the secret's name, e.g. `AUTH_SECRET`.
// Add fields as values become available; missing ones are just reported.
//
// Reads that item as JSON (`op item get ... --reveal --format json`) on stdin.
//
//   node scripts/worker-secrets.mjs <env> [NAME...]
//     Prints the item's secrets (or only NAMEs) as JSON for
//     `wrangler secret bulk` on stdout; a summary of names goes to stderr.
//   node scripts/worker-secrets.mjs <env> --status '<wrangler secret list JSON>'
//     Prints which secrets 1Password and Cloudflare each have. Never values:
//     only lengths and line counts (a PEM should span several lines).

import { unstable_readConfig } from "wrangler";
import { WORKER_SECRETS } from "./lib/workerSecrets.ts";

const ENVIRONMENTS = ["production", "staging"];


function fail(message) {
  console.error(`worker-secrets: ${message}`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The item's secret fields as a Map of name -> value, rejecting labels that aren't Worker secrets. */
function secretsFromItem(item) {
  const secrets = new Map();
  for (const field of item.fields ?? []) {
    // Built-in fields (a Secure Note's notes, a Login's username/password).
    if (field.purpose) continue;
    if (!WORKER_SECRETS.includes(field.label)) {
      fail(`1Password field "${field.label}" isn't a Worker secret name (typo?). Expected one of: ${WORKER_SECRETS.join(", ")}`);
    }
    if (secrets.has(field.label)) fail(`1Password field "${field.label}" appears more than once`);
    if (field.value) secrets.set(field.label, field.value);
  }
  return secrets;
}

/** Secrets that are absent in normal operation, so `--status` shouldn't call them missing. */
const OPTIONAL_SECRETS = ["PASS_SIGNATURE_KEY_PREVIOUS"];

/** Secrets whose value has to be a PEM-encoded certificate or key. */
const PEM_SECRETS = WORKER_SECRETS.filter((name) => name.endsWith("_PEM"));

/**
 * Why `value` can't be used as a PEM secret, or null if it can.
 *
 * 1Password's password fields strip line breaks, which is harmless: both
 * parsers this project uses -- `node-forge` for pass signing
 * (src/passkit/signer.ts) and `jose` wherever a JWT is signed -- throw away
 * whitespace before decoding the base64, so a PEM that has lost its newlines
 * still parses exactly like a well-formed one.
 *
 * What does not work is a value carrying literal `\n` escapes, which is the
 * shape you get by copying `private_key` straight out of a Google
 * service-account JSON file. Those two characters survive into the base64 and
 * the decode fails at runtime, a long way from the paste that caused it:
 * `node-forge` reports "Invalid PEM formatted message" and `jose` reports
 * "asn1 encoding routines::too long". Catching it here means it never reaches
 * a Worker.
 *
 * The markers are not enough on their own, which cost a staging outage on
 * 2026-09-17: a `.p8` arrived with intact `BEGIN`/`END` lines and a body that
 * would not base64-decode, passed this check, and threw inside `importPKCS8`
 * at request time. So the body is decoded here too -- cheap, and it is the
 * same thing every consumer of the value goes on to do.
 */
function pemProblem(name, value) {
  if (!PEM_SECRETS.includes(name)) return null;
  if (value.includes("\\n")) {
    return 'contains literal "\\n" escapes rather than line breaks, and will fail to parse. Copy the file\'s own text (1Password strips the line breaks, which is fine), not a JSON string containing it.';
  }
  const begin = value.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
  if (!begin) {
    return 'has no "-----BEGIN ...-----" marker, so it isn\'t PEM. Expected the contents of a .pem or .p8 file (a .cer is DER: convert it with `openssl x509 -inform DER -in cert.cer -out cert.pem`).';
  }
  if (!value.includes(`-----END ${begin[1]}-----`)) {
    return `opens "${begin[1]}" but has no matching "-----END ${begin[1]}-----", so the value looks truncated.`;
  }
  if (begin[1] === "ENCRYPTED PRIVATE KEY") {
    return "is passphrase-protected, which node-forge can't read. Strip the passphrase first: `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-nocrypt.pem`.";
  }
  // Every parser strips whitespace, then decodes what's between the markers.
  const body = value
    .slice(value.indexOf(begin[0]) + begin[0].length, value.indexOf(`-----END ${begin[1]}-----`))
    .replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) {
    return `has a "${begin[1]}" body that isn't valid base64, so every parser will reject it. Re-copy the file's contents; something has mangled them in transit.`;
  }
  return null;
}

const [env, ...rest] = process.argv.slice(2);
if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);

// `wrangler secret put`/`bulk` refuses a name already bound as a plain var
// (workers-sdk#7287); catch that before touching Cloudflare.
const vars = Object.keys(
  unstable_readConfig({ config: "wrangler.toml", env: env === "production" ? undefined : env }, { hideWarnings: true }).vars,
);
const clashing = WORKER_SECRETS.filter((name) => vars.includes(name));
if (clashing.length) fail(`wrangler.toml binds these as plain vars, so they can't be secrets: ${clashing.join(", ")}`);

const input = await readStdin();
let item;
try {
  item = JSON.parse(input);
} catch {
  fail("expected the 1Password item as JSON on stdin (did `op item get` fail?)");
}
const secrets = secretsFromItem(item);

if (rest[0] === "--status") {
  let cloudflare;
  try {
    cloudflare = new Set(JSON.parse(rest[1]).map((secret) => secret.name));
  } catch {
    fail("--status expects `wrangler secret list --format json` output as its argument");
  }
  console.log(`Worker secrets for ${env} (1Password item "${item.title}"):`);
  for (const name of WORKER_SECRETS) {
    const value = secrets.get(name);
    const absent = OPTIONAL_SECRETS.includes(name) ? "not set (optional)" : "missing";
    const inOnePassword = value ? `${value.length} chars, ${value.split("\n").length} line(s)` : absent;
    const problem = value ? pemProblem(name, value) : null;
    console.log(
      `  ${name.padEnd(36)} 1Password: ${inOnePassword.padEnd(24)} Cloudflare: ${cloudflare.has(name) ? "set" : "missing"}${problem ? `   !! ${problem}` : ""}`,
    );
  }
  const unexpected = [...cloudflare].filter((name) => !WORKER_SECRETS.includes(name));
  if (unexpected.length) console.log(`  Set in Cloudflare but not a known Worker secret: ${unexpected.join(", ")}`);
  process.exit(0);
}

const requested = rest.length ? rest : [...secrets.keys()];
for (const name of requested) {
  if (!WORKER_SECRETS.includes(name)) fail(`"${name}" isn't a Worker secret name`);
  if (!secrets.has(name)) fail(`"${name}" has no value in 1Password item "${item.title}"`);
  const problem = pemProblem(name, secrets.get(name));
  if (problem) fail(`"${name}" in 1Password item "${item.title}": ${problem}`);
}
if (!requested.length) fail(`1Password item "${item.title}" has no secret values yet`);

const missing = WORKER_SECRETS.filter(
  (name) => !secrets.has(name) && !OPTIONAL_SECRETS.includes(name),
);
console.error(`Pushing ${requested.length} secret(s) to ${env}: ${requested.join(", ")}`);
if (missing.length && !rest.length) console.error(`Not in 1Password yet (skipped): ${missing.join(", ")}`);
process.stdout.write(JSON.stringify(Object.fromEntries(requested.map((name) => [name, secrets.get(name)]))));
