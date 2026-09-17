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

const ENVIRONMENTS = ["production", "staging"];

/** Every Worker secret the code reads (`Env` in src/index.ts, minus the plain vars in wrangler.toml). */
export const WORKER_SECRETS = [
  // Login and sessions
  "AUTH_SECRET",
  "SESSION_SIGNING_KEY",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "APPLE_SIGNIN_KEY_ID",
  "APPLE_SIGNIN_PRIVATE_KEY_PEM",
  // BigCommerce
  "BIGCOMMERCE_ACCESS_TOKEN",
  "BIGCOMMERCE_WEBHOOK_SIGNING_KEY",
  // Apple Wallet passes and QR verification
  "APPLE_PASS_CERT_PEM",
  "APPLE_PASS_KEY_PEM",
  "APPLE_WWDR_CERT_PEM",
  "PASS_SIGNATURE_KEY",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY_PEM",
  // Google Wallet
  "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WALLET_PRIVATE_KEY_PEM",
  // Email card delivery
  "SENDGRID_API_KEY",
  "TURNSTILE_SECRET_KEY", // TURNSTILE_SITE_KEY is public: a plain var in wrangler.toml
  // Slack members sync
  "SLACK_BOT_TOKEN",
];

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
    const inOnePassword = value ? `${value.length} chars, ${value.split("\n").length} line(s)` : "missing";
    console.log(`  ${name.padEnd(36)} 1Password: ${inOnePassword.padEnd(24)} Cloudflare: ${cloudflare.has(name) ? "set" : "missing"}`);
  }
  const unexpected = [...cloudflare].filter((name) => !WORKER_SECRETS.includes(name));
  if (unexpected.length) console.log(`  Set in Cloudflare but not a known Worker secret: ${unexpected.join(", ")}`);
  process.exit(0);
}

const requested = rest.length ? rest : [...secrets.keys()];
for (const name of requested) {
  if (!WORKER_SECRETS.includes(name)) fail(`"${name}" isn't a Worker secret name`);
  if (!secrets.has(name)) fail(`"${name}" has no value in 1Password item "${item.title}"`);
}
if (!requested.length) fail(`1Password item "${item.title}" has no secret values yet`);

const missing = WORKER_SECRETS.filter((name) => !secrets.has(name));
console.error(`Pushing ${requested.length} secret(s) to ${env}: ${requested.join(", ")}`);
if (missing.length && !rest.length) console.error(`Not in 1Password yet (skipped): ${missing.join(", ")}`);
process.stdout.write(JSON.stringify(Object.fromEntries(requested.map((name) => [name, secrets.get(name)]))));
