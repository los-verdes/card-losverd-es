// Creates or updates an environment's BigCommerce order webhook: scope
// `store/order/*`, delivered to `<origin>/bigcommerce/order-webhook` with the
// `Authorization: bearer <token>` header the Worker verifies. Ports the legacy
// app's `ensure-order-webhook` command. See the `bigcommerce-ensure-webhook`
// recipe in the justfile.
//
// Reads the environment's 1Password Worker secrets item (the same one
// `just secrets-push` uses) as JSON on stdin, for BIGCOMMERCE_ACCESS_TOKEN
// and BIGCOMMERCE_WEBHOOK_SIGNING_KEY; the store hash, client id, and default
// origin come from wrangler.toml. Never prints the token or any secret.
//
//   node scripts/bigcommerce-webhook.mjs <env> [--dry-run] [--origin https://...] [--cutover]
//
// The token is computed by the Worker's own src/bigcommerce/webhookToken.ts
// (imported directly; Node strips its types), so it can't drift from what
// the Worker checks.

import { unstable_readConfig } from "wrangler";
import { signWebhookToken } from "../src/bigcommerce/webhookToken.ts";
import { opField, readOpItemFromStdin } from "./lib/opItem.ts";

const ENVIRONMENTS = ["production", "staging"];
const SCOPE = "store/order/*";
const WEBHOOK_PATH = "/bigcommerce/order-webhook";
// Production's public origin is also where the *legacy* app's webhook points
// until DNS cutover: re-registering it earlier would swap the legacy app's
// token for ours and break its order syncs.
const LEGACY_SHARED_ORIGIN = "https://card.losverd.es";
// Overridable only to test against a local stub.
const API_BASE = process.env.BIGCOMMERCE_API_BASE ?? "https://api.bigcommerce.com";

function fail(message) {
  console.error(`bigcommerce-webhook: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [env, ...rest] = argv;
  if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);
  const options = { env, dryRun: false, cutover: false, origin: undefined };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") options.dryRun = true;
    else if (rest[i] === "--cutover") options.cutover = true;
    else if (rest[i] === "--origin" && rest[i + 1]) options.origin = rest[++i];
    else fail(`unknown argument "${rest[i]}"`);
  }
  return options;
}

/** Thin wrappers so the shared helpers report failures under this tool's name. */
const readItem = () => readOpItemFromStdin(fail);
const fieldValue = (item, label) => opField(item, label, fail);

async function bigcommerce(method, url, accessToken, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) fail(`${method} ${new URL(url).pathname} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const options = parseArgs(process.argv.slice(2));
const { vars } = unstable_readConfig(
  { config: "wrangler.toml", env: options.env === "production" ? undefined : options.env },
  { hideWarnings: true },
);
// `op` is piping the 1Password item into stdin, so drain it before any check
// that can exit. Exiting first closes the pipe under them, and their own
// "write /dev/stdout: The pipe is being closed" arrives after our message
// and reads like a second, unrelated failure.
const item = await readItem();

const storeHash = vars.BIGCOMMERCE_STORE_HASH;
const clientId = vars.BIGCOMMERCE_CLIENT_ID;
if (!storeHash || !clientId || String(clientId).startsWith("REPLACE_WITH")) {
  fail(`set the real BIGCOMMERCE_CLIENT_ID for ${options.env} in wrangler.toml first (the token covers it)`);
}

const origin = (options.origin ?? vars.PUBLIC_BASE_URL).replace(/\/$/, "");
if (options.env === "production" && origin === LEGACY_SHARED_ORIGIN && !options.cutover) {
  fail(
    `${LEGACY_SHARED_ORIGIN} is still the legacy app's webhook destination; re-registering it swaps in this Worker's token. ` +
      `Before cutover pass --origin https://card-losverd-es.jeff-hogan1.workers.dev; at cutover pass --cutover.`,
  );
}
const destination = `${origin}${WEBHOOK_PATH}`;

const accessToken = fieldValue(item, "BIGCOMMERCE_ACCESS_TOKEN");
const token = await signWebhookToken(fieldValue(item, "BIGCOMMERCE_WEBHOOK_SIGNING_KEY"), storeHash, clientId);

const hooksUrl = `${API_BASE}/stores/${storeHash}/v3/hooks`;
const listed = await bigcommerce("GET", `${hooksUrl}?${new URLSearchParams({ scope: SCOPE, destination })}`, accessToken);
// Filter again locally in case the API ignores a query parameter.
const existing = listed.data.filter((hook) => hook.scope === SCOPE && hook.destination === destination);
if (existing.length > 1) fail(`found ${existing.length} ${SCOPE} webhooks for ${destination}; remove the extras first (ids ${existing.map((h) => h.id).join(", ")})`);

const hook = {
  scope: SCOPE,
  destination,
  is_active: true,
  events_history_enabled: true,
  headers: { authorization: `bearer ${token}` },
};
const action = existing.length ? `update webhook ${existing[0].id}` : "create a webhook";
if (options.dryRun) {
  console.log(`Dry run: would ${action} on store ${storeHash}: ${SCOPE} -> ${destination}`);
  process.exit(0);
}
const saved = existing.length
  ? await bigcommerce("PUT", `${hooksUrl}/${existing[0].id}`, accessToken, hook)
  : await bigcommerce("POST", hooksUrl, accessToken, hook);
console.log(
  `${existing.length ? "Updated" : "Created"} webhook ${saved.data.id} on store ${storeHash}: ${saved.data.scope} -> ${saved.data.destination} (active: ${saved.data.is_active})`,
);
