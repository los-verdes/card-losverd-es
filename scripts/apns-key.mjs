// APNs auth key: check one before storing it, and report what is installed.
//
// This is the key that lets the Worker tell an already-installed Wallet pass
// to come back for a new version. Without it a member who renews keeps seeing
// their old expiry until something else makes their phone re-fetch the pass,
// and that is the one part of the experience re-issuing cannot repair.
//
// Apple's `.p8` download happens exactly once -- "the key is not saved in your
// developer account and you won't be able to download it again" -- so a file
// that turns out to be unusable after the console has moved on means creating
// another key. Everything here runs before the file is stored anywhere.
//
//   node scripts/apns-key.mjs check <key.p8> --key-id <id>
//     Parses the key, signs a provider token with it exactly as the Worker
//     does, and reports what it would be stored as.
//
//   node scripts/apns-key.mjs status
//     Reads an environment's 1Password item as JSON on stdin and says which
//     key is installed.
//
// See `just apns-key-install` and `just apns-key-status`.

import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { unstable_readConfig } from "wrangler";
import { opFieldOrNull, readOpItemFromStdin } from "./lib/opItem.ts";

function fail(message) {
  console.error(`apns-key: ${message}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const flagValue = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
};
const positional = rest.filter(
  (arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--"),
);

/**
 * Apple shows the key id as ten upper-case alphanumerics. Checked because it
 * is typed by hand from a web page, and a wrong one fails at push time with
 * `InvalidProviderToken` -- which reads like a bad key rather than a typo.
 */
const KEY_ID_SHAPE = /^[A-Z0-9]{10}$/;

async function commandCheck(path, keyId) {
  if (!path) fail("check needs the path to the .p8 Apple gave you");
  if (!keyId) fail("check needs --key-id, the ten-character Key ID from the console");
  if (!KEY_ID_SHAPE.test(keyId)) {
    fail(`--key-id should be ten upper-case letters and digits; got ${JSON.stringify(keyId)}`);
  }

  let pem;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${path}`);
  }
  if (!pem.includes("-----BEGIN PRIVATE KEY-----")) {
    fail(
      `${path} is not a PKCS#8 private key. An APNs auth key downloads as a .p8 beginning "-----BEGIN PRIVATE KEY-----"; a .cer or .p12 is something else.`,
    );
  }

  const { vars } = unstable_readConfig({ config: "wrangler.toml" }, { hideWarnings: true });
  const teamId = vars.PASSKIT_TEAM_IDENTIFIER;
  const topic = vars.PASSKIT_PASS_TYPE_IDENTIFIER;

  // Exactly what src/passkit/apns.ts does at push time. A key of the wrong
  // curve, or a truncated download, fails here rather than in production.
  let key;
  try {
    key = await importPKCS8(pem, "ES256");
  } catch (error) {
    fail(
      `${path} will not load as an ES256 key (${String(error)}). APNs auth keys are P-256; re-download it, or check nothing mangled it in transit.`,
    );
  }
  try {
    await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .sign(key);
  } catch (error) {
    fail(`the key loaded but would not sign a provider token: ${String(error)}`);
  }

  console.log(`${path} is a usable APNs auth key.`);
  console.log(`  Key ID   ${keyId}`);
  console.log(`  Team     ${teamId} (PASSKIT_TEAM_IDENTIFIER)`);
  console.log(`  Topic    ${topic} (PASSKIT_PASS_TYPE_IDENTIFIER)`);
  console.log(
    "\nWhat this cannot check: that Apple will accept it. The key is signed here,\n" +
      "not by Apple, so a key revoked in the console or scoped to a different topic\n" +
      "looks identical until the first push. Confirm on a real device.",
  );
}

async function commandStatus() {
  const item = await readOpItemFromStdin(fail);
  const keyId = opFieldOrNull(item, "APNS_KEY_ID");
  const pem = opFieldOrNull(item, "APNS_PRIVATE_KEY_PEM");
  if (!keyId && !pem) {
    console.log(`No APNs key in "${item.title}". Installed passes are never told to refresh.`);
    process.exit(0);
  }
  if (!keyId || !pem) {
    fail(
      `"${item.title}" has ${keyId ? "APNS_KEY_ID but no APNS_PRIVATE_KEY_PEM" : "APNS_PRIVATE_KEY_PEM but no APNS_KEY_ID"}. Both or neither: the Worker skips pushing unless it has both, so a half-set pair is silently the same as none.`,
    );
  }
  console.log(`"${item.title}": key ${keyId}, ${pem.length} chars of PEM.`);
}

switch (command) {
  case "check":
    await commandCheck(positional[0], flagValue("--key-id"));
    break;
  case "status":
    await commandStatus();
    break;
  default:
    fail("first argument must be check or status");
}
