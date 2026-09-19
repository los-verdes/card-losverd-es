// Checks that staging and production share no secret values.
//
// The rule (decided 2026-09-17): the two environments should have nothing in
// common that could be used to act as the other. A value reused across both
// means a staging leak is a production compromise, and that staging can sign,
// fetch or publish something production is trusted for. The few values that
// genuinely cannot differ are listed in SHARED_BY_NECESSITY below, each with
// the reason, so the exceptions stay deliberate rather than accumulating.
//
// Never prints a secret's value -- only its name and whether the two
// environments agree. A tool that reported "these two match: <value>" would
// be a worse leak than the one it is looking for.
//
// Unlike the other tools here, this one runs `op` itself rather than taking a
// piped item on stdin: it needs two items, and stdin only carries one. Values
// arrive on `op`'s stdout, never in an argument, which is the property the
// piping convention exists to protect.
//
// Usage:
//   just secrets-compare
//   node scripts/secrets-compare.mjs
//   node scripts/secrets-compare.mjs --fixture <path>   (see below)

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { WORKER_SECRETS } from "./lib/workerSecrets.ts";

const run = promisify(execFile);

const VAULT = "Los Verdes";
const ITEM = (env) => `lv-card-losverd-es-worker-${env}`;
const ENVIRONMENTS = ["production", "staging"];

/**
 * Secrets the two environments are expected to share, and why. Anything here
 * is reported but not treated as a failure; anything not here that matches
 * is a failure.
 */
const SHARED_BY_NECESSITY = {
  APPLE_SIGNIN_KEY_ID:
    "Apple allows only a small number of Sign in with Apple keys per team, so both environments sign with one. The Services IDs they sign for differ, which is what keeps the logins apart.",
  APPLE_SIGNIN_PRIVATE_KEY_PEM: "Same key as APPLE_SIGNIN_KEY_ID above.",
  APPLE_WWDR_CERT_PEM:
    "Apple's public WWDR intermediate certificate. The same bytes for everyone; not a secret at all, and kept alongside the others only because the pass signer wants all three together.",
};

function fail(message) {
  console.error(`secrets-compare: ${message}`);
  process.exit(1);
}

/**
 * Both environments' items.
 *
 * `--fixture` reads them from a JSON file of `{ production: item, staging:
 * item }` instead of 1Password, so the comparison can be exercised without a
 * vault. For made-up values only -- never point it at anything real.
 */
async function loadItems() {
  const fixtureFlag = process.argv.indexOf("--fixture");
  if (fixtureFlag !== -1) {
    const path = process.argv[fixtureFlag + 1];
    if (!path) fail("--fixture needs a path");
    return JSON.parse(await readFile(path, "utf8"));
  }
  const items = {};
  for (const env of ENVIRONMENTS) {
    try {
      const { stdout } = await run("op", [
        "item",
        "get",
        ITEM(env),
        "--vault",
        VAULT,
        "--reveal",
        "--format",
        "json",
      ]);
      items[env] = JSON.parse(stdout);
    } catch (err) {
      fail(`could not read the ${env} item from 1Password -- ${err.message.split("\n")[0]}`);
    }
  }
  return items;
}

/**
 * Secret name -> value, skipping 1Password's own built-in fields and blanks.
 *
 * Whitespace is stripped before comparing: 1Password strips newlines from
 * password fields, and two copies of the same PEM pasted at different times
 * can differ only in line endings. An exact match would call those different
 * and quietly miss a shared key, which is the wrong direction for this tool
 * to fail in.
 */
function secretsOf(item) {
  const secrets = new Map();
  for (const field of item.fields ?? []) {
    if (field.purpose) continue;
    if (WORKER_SECRETS.includes(field.label) && field.value) {
      secrets.set(field.label, field.value.replace(/\s+/g, ""));
    }
  }
  return secrets;
}

const items = await loadItems();
const [production, staging] = ENVIRONMENTS.map((env) => secretsOf(items[env] ?? {}));

const shared = [];
const expected = [];
let compared = 0;

for (const name of WORKER_SECRETS) {
  const a = production.get(name);
  const b = staging.get(name);
  if (a === undefined || b === undefined) continue;
  compared++;
  if (a !== b) continue;
  (SHARED_BY_NECESSITY[name] ? expected : shared).push(name);
}

if (compared === 0) {
  fail("no secret is set in both environments, so there was nothing to compare");
}

for (const name of expected) {
  console.log(`same (expected)  ${name}`);
  console.log(`                 ${SHARED_BY_NECESSITY[name]}`);
}

if (shared.length === 0) {
  console.log(
    `\nOK: of ${compared} secrets set in both environments, none share a value beyond the ${expected.length} expected to.`,
  );
  process.exit(0);
}

console.error(
  `\nsecrets-compare: ${shared.length === 1 ? "1 secret has" : `${shared.length} secrets have`} the same value in staging and production:\n` +
    shared.map((name) => `  - ${name}`).join("\n") +
    "\n\nRotate the staging one. Generate a fresh value, put it in the staging\n" +
    "1Password item, and `just secrets-push staging <NAME>`. Production keeps\n" +
    "the value it has, so nothing members hold is affected.",
);
process.exit(1);
