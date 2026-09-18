/**
 * Detailed validation of an environment's Google Wallet setup.
 *
 * The reason this exists: when a "Save to Google Wallet" link fails, the
 * member sees "Something went wrong. Please try again." and nothing else, and
 * the JWT is validated inside Google rather than by us, so there is no log to
 * read. That one message covers a missing class, a service account without
 * issuer access, an issuer still in demo mode, and an object missing a
 * required field. This tool separates those.
 *
 * It builds the object with the Worker's own `buildGenericObject()` and the
 * shared branding, so what is checked is what members actually get.
 *
 *   node scripts/google-wallet-check.ts <env> [--insert] [--object <memberId>]
 *
 * Read-only by default. `--insert` writes a synthetic object to the issuer
 * account, which is how Google can be made to say what is actually wrong --
 * see the note on that flag below.
 *
 * Reads the environment's 1Password Worker secrets item as JSON on stdin, the
 * same way the other scripts here do.
 */
import { SignJWT, importPKCS8 } from "jose";
import { unstable_readConfig } from "wrangler";
import {
  buildGenericObject,
  googleWalletConfig,
  type GenericObject,
  type MemberWalletInput,
} from "../src/google/jwt";

const ENVIRONMENTS = ["production", "staging"];
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const WALLET_API = process.env.GOOGLE_WALLET_API ?? "https://walletobjects.googleapis.com/walletobjects/v1";

/**
 * Fields Google documents as required on a `GenericObject`. Encoded here so a
 * missing one is named rather than guessed at -- but `--insert` is the
 * authoritative check, since only Google knows what Google enforces.
 */
const REQUIRED_OBJECT_FIELDS = [
  "id",
  "classId",
  "cardTitle",
  "header",
  "hexBackgroundColor",
  "logo",
] as const;

/** Deliberately synthetic: this stands in for a member, and may reach Google. */
const SAMPLE_MEMBER: MemberWalletInput = {
  memberId: "LV-00000000-0000-4000-8000-000000000000",
  firstName: "Casey",
  lastName: "Example",
  membershipTier: "standard",
  status: "active",
  expirationDate: "2099-02-17",
  memberSince: "2021-07-01",
  verifyUrl: "https://example.test/verify-pass/LV-00000000-0000-4000-8000-000000000000?signature=sample",
};

function fail(message: string): never {
  console.error(`google-wallet-check: ${message}`);
  process.exit(1);
}

async function readItem(): Promise<{ title?: string; fields?: { label: string; value: string }[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("expected the 1Password item as JSON on stdin (did `op item get` fail?)");
  }
}

function fieldValue(item: Awaited<ReturnType<typeof readItem>>, label: string): string {
  const value = item.fields?.find((field) => field.label === label)?.value;
  if (!value) fail(`1Password item "${item.title}" has no ${label}`);
  return value;
}

async function accessToken(email: string, privateKeyPem: string): Promise<string> {
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
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    fail(`the service account could not get a token: ${res.status} ${await res.text()}`);
  }
  const { access_token: token } = (await res.json()) as { access_token?: string };
  if (!token) fail("the token response had no access_token");
  return token;
}

interface WalletResult {
  status: number;
  body: string;
}

async function wallet(method: string, path: string, token: string, body?: unknown): Promise<WalletResult> {
  const res = await fetch(`${WALLET_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Google returns 403 for two unrelated problems, distinguished only by the
 * response body: the Wallet API not being enabled in the service account's
 * GCP project, versus the service account having no access to this issuer.
 * Confirmed against a real 403 on 2026-09-17.
 */
function explain403(body: string): string {
  if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(body)) {
    return "the Google Wallet API is not enabled in the service account's GCP project (the error body links straight to the page that enables it)";
  }
  if (/permissionDenied|Permission denied|caller does not have permission/i.test(body)) {
    return "the service account has no access to this issuer. Add its email in the Google Pay & Wallet Console under Google Wallet API -> Users, with at least Developer access";
  }
  return "403 with an unfamiliar body -- worth reading in full above";
}

function report(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
  if (!ok) process.exitCode = 1;
}

const [env, ...rest] = process.argv.slice(2);
if (!ENVIRONMENTS.includes(env)) fail(`first argument must be one of: ${ENVIRONMENTS.join(", ")}`);
const insert = rest.includes("--insert");
const objectAt = rest.indexOf("--object");
const objectMemberId = objectAt === -1 ? null : rest[objectAt + 1];
for (const [index, arg] of rest.entries()) {
  if (arg.startsWith("--") && arg !== "--insert" && arg !== "--object") fail(`unknown argument "${arg}"`);
  if (arg === "--object" && !rest[index + 1]) fail("--object needs a member id");
}

const { vars } = unstable_readConfig(
  { config: "wrangler.toml", env: env === "production" ? undefined : env },
  { hideWarnings: true },
);
const config = googleWalletConfig({
  issuerId: vars.GOOGLE_WALLET_ISSUER_ID as string,
  classSuffix: vars.GOOGLE_WALLET_CLASS_SUFFIX as string,
  baseUrl: vars.PUBLIC_BASE_URL as string,
});
const classId = `${config.issuerId}.${config.classSuffix}`;

const item = await readItem();
const token = await accessToken(
  fieldValue(item, "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
  fieldValue(item, "GOOGLE_WALLET_PRIVATE_KEY_PEM"),
);

console.log(`Google Wallet for ${env}:`);
console.log(`  issuer ${config.issuerId}, class ${config.classSuffix}, origins ${config.origins.join(", ")}`);
console.log("");
report("service account token", true, "the credentials sign and exchange correctly");

// 1. Does the class exist, and can this service account see it?
const classResult = await wallet("GET", `/genericClass/${encodeURIComponent(classId)}`, token);
if (classResult.status === 200) {
  report("class exists", true, classId);
} else if (classResult.status === 404) {
  report("class exists", false, `no class ${classId} -- run \`just google-wallet-ensure-class ${env}\``);
} else if (classResult.status === 403) {
  report("class readable", false, explain403(classResult.body));
} else {
  report("class readable", false, `${classResult.status}: ${classResult.body.slice(0, 200)}`);
}

// 2. Does the object the Worker builds carry everything Google needs?
const object = buildGenericObject(SAMPLE_MEMBER, config) as GenericObject & Record<string, unknown>;
const missing = REQUIRED_OBJECT_FIELDS.filter((field) => object[field] === undefined);
report(
  "object has required fields",
  missing.length === 0,
  missing.length === 0
    ? REQUIRED_OBJECT_FIELDS.join(", ")
    : `missing ${missing.join(", ")} -- Google documents these as required, and a missing one is one cause of the generic "Something went wrong"`,
);

// 3. An existing member's object, if asked for. Read-only.
if (objectMemberId) {
  const objectId = `${config.issuerId}.${objectMemberId}`;
  const result = await wallet("GET", `/genericObject/${encodeURIComponent(objectId)}`, token);
  if (result.status === 200) {
    const saved = JSON.parse(result.body) as { classId?: string; state?: string };
    report("member's saved object", true, `state ${saved.state}, class ${saved.classId}`);
  } else if (result.status === 404) {
    report("member's saved object", true, "none yet -- nobody has saved this member's pass");
  } else {
    report("member's saved object", false, `${result.status}: ${result.body.slice(0, 200)}`);
  }
}

// 4. The authoritative check, opt-in because it writes.
if (insert) {
  // Wallet objects cannot be deleted once created, so this leaves a synthetic
  // object on the issuer account permanently. It is inert -- nobody holds it,
  // and its id is obviously not a real member -- but it is why this is a flag
  // rather than the default.
  const result = await wallet("POST", "/genericObject", token, object);
  if (result.status === 200) {
    report("object accepted by Google", true, `inserted ${object.id} (synthetic, harmless, permanent)`);
  } else if (result.status === 409) {
    report("object accepted by Google", true, "already inserted by an earlier run");
  } else if (result.status === 403) {
    report("object accepted by Google", false, explain403(result.body));
  } else {
    console.log("");
    console.log("Google's response in full:");
    console.log(result.body);
    report("object accepted by Google", false, `${result.status} -- see the body above for the field it objects to`);
  }
} else {
  console.log("");
  console.log("Pass --insert to have Google validate the object itself. That is the only");
  console.log("way to get a specific error instead of the save link's generic one; it");
  console.log("writes one synthetic, inert object that cannot afterwards be deleted.");
}

if (process.exitCode) {
  console.log("");
  console.log("Note: the issuer may also still be in demo mode, where only allow-listed");
  console.log("test accounts can save a pass and everyone else sees the generic error.");
  console.log("That is granted in the Google Pay & Wallet Console and cannot be checked");
  console.log("from here.");
}
