// Creates or updates an environment's Google Wallet generic class.
//
// Unlike an Apple pass, a Google Wallet pass is only half self-contained: the
// "Save to Google Wallet" JWT this app signs carries the *object*, and Google
// rejects it unless the class named by `classId` already exists on their side
// (the member sees a generic "Something went wrong"). Nothing else in this
// repo can create it, so this is the tool that does -- once per environment,
// and again whenever the class's branding changes.
//
// Reads the environment's 1Password Worker secrets item (the same one
// `just secrets-push` uses) as JSON on stdin, for the service account
// credentials; the issuer id and class suffix come from wrangler.toml.
//
//   node scripts/google-wallet-class.mjs <env> [--dry-run]
//
// Prints what it would do, then does it. Never prints the key or the token.

import { fetchServiceAccountToken } from "../src/google/serviceAccountToken.ts";
import { unstable_readConfig } from "wrangler";
import { opField, readOpItemFromStdin } from "./lib/opItem.ts";

const ENVIRONMENTS = ["production", "staging"];
// Overridable only to test against a local stub.
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const WALLET_API = process.env.GOOGLE_WALLET_API ?? "https://walletobjects.googleapis.com/walletobjects/v1";

function fail(message) {
  console.error(`google-wallet-class: ${message}`);
  process.exit(1);
}

/** Thin wrappers so the shared helpers report failures under this tool's name. */
const readItem = () => readOpItemFromStdin(fail);
const fieldValue = (item, label) => opField(item, label, fail);

/**
 * A short-lived access token for the Wallet API. The exchange itself lives in
 * `src/google/serviceAccountToken.ts`, shared with the Worker and the check
 * tool so the scope and assertion lifetime cannot drift between them.
 */
async function accessToken(email, privateKeyPem) {
  try {
    return await fetchServiceAccountToken(email, privateKeyPem, undefined, TOKEN_URL);
  } catch (error) {
    fail(String(error instanceof Error ? error.message : error));
  }
}

async function wallet(method, path, token, body) {
  const res = await fetch(`${WALLET_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const [env, ...rest] = process.argv.slice(2);
if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);
const dryRun = rest.includes("--dry-run");
for (const arg of rest) if (arg !== "--dry-run") fail(`unknown argument "${arg}"`);

const { vars } = unstable_readConfig(
  { config: "wrangler.toml", env: env === "production" ? undefined : env },
  { hideWarnings: true },
);
const classId = `${vars.GOOGLE_WALLET_ISSUER_ID}.${vars.GOOGLE_WALLET_CLASS_SUFFIX}`;

const item = await readItem();
const token = await accessToken(
  fieldValue(item, "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
  fieldValue(item, "GOOGLE_WALLET_PRIVATE_KEY_PEM"),
);

const existing = await wallet("GET", `/genericClass/${encodeURIComponent(classId)}`, token);
// Branding lives on each object the Worker signs (src/google/jwt.ts), so the
// class itself only has to exist and allow one holder per device.
const body = {
  id: classId,
  multipleDevicesAndHoldersAllowedStatus: "ONE_USER_ALL_DEVICES",
};
if (dryRun) {
  console.log(`Dry run: would ${existing ? "update" : "create"} generic class ${classId} for ${env}`);
  process.exit(0);
}
const saved = existing
  ? await wallet("PUT", `/genericClass/${encodeURIComponent(classId)}`, token, body)
  : await wallet("POST", "/genericClass", token, body);
console.log(`${existing ? "Updated" : "Created"} generic class ${saved.id} for ${env}`);
