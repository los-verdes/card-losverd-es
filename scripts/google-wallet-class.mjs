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

import { SignJWT, importPKCS8 } from "jose";
import { unstable_readConfig } from "wrangler";

const ENVIRONMENTS = ["production", "staging"];
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
// Overridable only to test against a local stub.
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const WALLET_API = process.env.GOOGLE_WALLET_API ?? "https://walletobjects.googleapis.com/walletobjects/v1";

function fail(message) {
  console.error(`google-wallet-class: ${message}`);
  process.exit(1);
}

async function readItem() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("expected the 1Password item as JSON on stdin (did `op item get` fail?)");
  }
}

function fieldValue(item, label) {
  const value = item.fields?.find((field) => field.label === label)?.value;
  if (!value) fail(`1Password item "${item.title}" has no ${label}`);
  return value;
}

/** A short-lived access token for the Wallet API, via the service account. */
async function accessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(await importPKCS8(privateKeyPem, "RS256"));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) fail(`token request failed: ${res.status} ${await res.text()}`);
  const { access_token: token } = await res.json();
  if (!token) fail("token response had no access_token");
  return token;
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
