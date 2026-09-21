// Every webhook registered on an environment's BigCommerce store, and whether
// each one still belongs.
//
// Hooks outlive the thing they point at. Moving to a new Cloudflare account
// changed both environments' workers.dev hostnames, and a hook registered
// against the old one keeps being delivered to -- into an old deployment's
// database if that deployment still runs, or nowhere if it does not. Neither
// looks wrong from the store's side. This makes them visible.
//
//   node scripts/bigcommerce-webhooks.mjs <env> [--origin https://...] [--delete <id>]
//
// Reads the environment's 1Password Worker secrets item as JSON on stdin, for
// BIGCOMMERCE_ACCESS_TOKEN; the store hash and PUBLIC_BASE_URL come from
// wrangler.toml. `--origin` names another origin that is current for this
// environment -- the recipe passes its workers.dev one.
//
// Deletion takes one id, chosen by a person. There is deliberately no "delete
// everything stale": before cutover a hook on `card.losverd.es` belongs to the
// previous site, which is still serving members, and a rule that swept it
// would break their order syncs.
//
// Never prints a hook's headers: they carry the token the Worker verifies.

import { unstable_readConfig } from "wrangler";
import { opField, readOpItemFromStdin } from "./lib/opItem.ts";

const ENVIRONMENTS = ["production", "staging"];
const WEBHOOK_PATH = "/bigcommerce/order-webhook";
// Overridable only to test against a local stub.
const API_BASE = process.env.BIGCOMMERCE_API_BASE ?? "https://api.bigcommerce.com";
const PROBE_TIMEOUT_MS = 5000;

function fail(message) {
  console.error(`bigcommerce-webhooks: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [env, ...rest] = argv;
  if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);
  const options = { env, origins: [], deleteId: undefined };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--origin" && rest[i + 1]) options.origins.push(rest[++i]);
    else if (rest[i] === "--delete" && rest[i + 1]) options.deleteId = rest[++i];
    else fail(`unknown argument "${rest[i]}"`);
  }
  return options;
}

async function bigcommerce(method, url, accessToken) {
  const res = await fetch(url, {
    method,
    headers: { "X-Auth-Token": accessToken, Accept: "application/json" },
  });
  if (!res.ok) fail(`${method} ${new URL(url).pathname} failed: HTTP ${res.status} ${await res.text()}`);
  return method === "DELETE" ? null : res.json();
}

/**
 * Whether anything answers at a destination's origin, as evidence rather
 * than as the verdict: an old deployment that still runs answers perfectly
 * well, and is exactly the case worth seeing.
 */
async function probe(destination) {
  try {
    const res = await fetch(new URL(destination).origin, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { answers: true, detail: `answers (HTTP ${res.status})` };
  } catch (error) {
    const reason = error?.cause?.code ?? error?.name ?? "no response";
    return { answers: false, detail: `no answer (${reason})` };
  }
}

/** One of `current`, `not-ours`, `stale`, or `other`, with a sentence. */
function verdictFor(hook, currentOrigins, publicOrigin) {
  let url;
  try {
    url = new URL(hook.destination);
  } catch {
    return { kind: "other", why: "the destination is not a URL" };
  }
  if (currentOrigins.includes(url.origin) && url.pathname === WEBHOOK_PATH) {
    // On the public hostname this cannot be told apart from the previous
    // site's own hook, which uses the same path: before cutover that hostname
    // is still the previous site. Treated as current either way, which is the
    // safe reading -- it can never be deleted from here.
    const where =
      url.origin === publicOrigin
        ? `delivers to ${publicOrigin}, this environment's public hostname -- which before cutover is still the previous site`
        : "delivers to this environment";
    return hook.is_active
      ? { kind: "current", why: where }
      : { kind: "current", why: `${where}, but BigCommerce has switched it off -- usually after repeated delivery failures` };
  }
  if (url.origin === publicOrigin) {
    // Before cutover the public origin is the previous site's, and so is any
    // hook on it that is not ours. Leave it alone.
    return { kind: "not-ours", why: "on this environment's public hostname but not this Worker's path -- the previous site's, until cutover" };
  }
  if (url.hostname.endsWith(".workers.dev")) {
    return { kind: "stale", why: "a workers.dev deployment that is not this environment's -- left over from an old account or an old name" };
  }
  return { kind: "other", why: "points somewhere this project does not recognise" };
}

const options = parseArgs(process.argv.slice(2));
const { vars } = unstable_readConfig(
  { config: "wrangler.toml", env: options.env === "production" ? undefined : options.env },
  { hideWarnings: true },
);
// Drain stdin before anything that can exit, so `op` is never left writing
// into a closed pipe (see bigcommerce-webhook.mjs).
const item = await readOpItemFromStdin(fail);
const accessToken = opField(item, "BIGCOMMERCE_ACCESS_TOKEN", fail);
const storeHash = vars.BIGCOMMERCE_STORE_HASH;
if (!storeHash) fail(`no BIGCOMMERCE_STORE_HASH for ${options.env} in wrangler.toml`);

const publicOrigin = new URL(vars.PUBLIC_BASE_URL).origin;
const currentOrigins = [publicOrigin, ...options.origins.map((o) => new URL(o).origin)];
const hooksUrl = `${API_BASE}/stores/${storeHash}/v3/hooks`;

if (options.deleteId) {
  const { data } = await bigcommerce("GET", `${hooksUrl}?limit=250`, accessToken);
  const hook = data.find((each) => String(each.id) === String(options.deleteId));
  if (!hook) fail(`store ${storeHash} has no webhook ${options.deleteId}`);
  const verdict = verdictFor(hook, currentOrigins, publicOrigin);
  // The one refusal: deleting the hook that delivers to this environment is
  // never what cleaning up means, and would stop orders arriving.
  if (verdict.kind === "current") {
    fail(`webhook ${hook.id} is the one delivering to ${options.env}; refusing to delete it`);
  }
  await bigcommerce("DELETE", `${hooksUrl}/${hook.id}`, accessToken);
  console.log(`Deleted webhook ${hook.id} (${hook.scope} -> ${hook.destination}) from store ${storeHash}.`);
  process.exit(0);
}

const { data } = await bigcommerce("GET", `${hooksUrl}?limit=250`, accessToken);
if (data.length === 0) {
  console.log(`Store ${storeHash} (${options.env}) has no webhooks at all -- no orders are delivered to anything.`);
  process.exit(0);
}

console.log(`Webhooks on store ${storeHash} (${options.env}):\n`);
const stale = [];
for (const hook of data) {
  const verdict = verdictFor(hook, currentOrigins, publicOrigin);
  const evidence = verdict.kind === "current" ? null : await probe(hook.destination);
  console.log(`  ${String(hook.id).padEnd(10)} ${verdict.kind.toUpperCase().padEnd(9)} ${hook.scope}  ${hook.is_active ? "" : "(inactive) "}${hook.destination}`);
  console.log(`  ${" ".repeat(10)} ${verdict.why}${evidence ? `; ${evidence.detail}` : ""}`);
  if (verdict.kind === "stale" && evidence?.answers) {
    // Worth saying outright: a hook here is not merely untidy, it is putting
    // orders somewhere other than this environment's database.
    console.log(`  ${" ".repeat(10)} Still answering, so orders delivered here reach that deployment instead of this one.`);
  }
  if (verdict.kind === "stale") stale.push(hook);
}

if (!data.some((hook) => verdictFor(hook, currentOrigins, publicOrigin).kind === "current")) {
  console.log(`\nNothing delivers to ${options.env}. Register one with \`just bigcommerce-ensure-webhook ${options.env}\`.`);
}
if (stale.length) {
  console.log(`\nTo remove ${stale.length === 1 ? "the stale one" : "each stale one"}:`);
  for (const hook of stale) {
    console.log(`  just bigcommerce-webhooks ${options.env} --delete ${hook.id}`);
  }
}
