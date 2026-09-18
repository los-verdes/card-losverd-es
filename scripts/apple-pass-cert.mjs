// Apple Pass Type ID certificate: request, install, and check.
//
// Apple issues these for one year, so signing new `.pkpass` bundles breaks
// annually unless someone renews. The process is short but easy to get subtly
// wrong -- a key that doesn't match the certificate, or a WWDR intermediate
// from the wrong generation, both produce a pass that iOS refuses to add with
// no explanation at all. So everything except Apple's own web console is
// automated here, and everything automated is verified.
//
//   node scripts/apple-pass-cert.mjs csr [--dir <dir>]
//     Generates a private key and a certificate signing request, then prints
//     what to do with the CSR in Apple's console.
//
//   node scripts/apple-pass-cert.mjs install <downloaded.cer> [--dir <dir>]
//     Converts Apple's download, checks it against the key and against this
//     project's pass type identifier, fetches the matching WWDR intermediate,
//     verifies the chain, and writes the three PEMs ready to upload.
//
//   node scripts/apple-pass-cert.mjs check
//     Reads the environment's 1Password item as JSON on stdin and reports what
//     is installed and how long it has left.
//
// See `just apple-pass-cert-*` and the README section "Renewing the Apple pass
// certificate".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { unstable_readConfig } from "wrangler";

const DEFAULT_DIR = ".apple-pass-cert";
// Overridable only to test the install path against a stand-in for Apple.
const CERT_AUTHORITY = process.env.APPLE_CERT_AUTHORITY ?? "https://www.apple.com/certificateauthority";
const ENVIRONMENTS = ["production", "staging"];
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  console.error(`apple-pass-cert: ${message}`);
  process.exit(1);
}

/**
 * How much life left in a certificate is acceptable, given these last a year
 * and a lapse stops new passes being issued entirely.
 *
 * `level` is `"ok"`, `"warn"` or `"expired"`; the caller exits non-zero for
 * anything that isn't `"ok"`, so this decides when `check` starts failing.
 */
function expiryVerdict(daysRemaining) {
  if (daysRemaining < 0) {
    return {
      level: "expired",
      message: "beyond time to renew our Apple dev certificate :sweat_smile:"
    }
  } else if (daysRemaining <= 30) {
    return {
      level: "warn",
      message: "Apple dev certificate is expiring in <= 30 days :yellow_siren:"
    }
  }

  return {
    level: "ok",
    message: "Apple dev certificate is a-okay!"
  }
}

/** This project's own pass identifiers, so a mismatched download is caught. */
function passIdentifiers(env) {
  const { vars } = unstable_readConfig(
    { config: "wrangler.toml", env: env === "production" ? undefined : env },
    { hideWarnings: true },
  );
  return {
    passTypeId: vars.PASSKIT_PASS_TYPE_IDENTIFIER,
    teamId: vars.PASSKIT_TEAM_IDENTIFIER,
  };
}

function subjectField(cert, shortName) {
  return cert.subject.getField(shortName)?.value ?? null;
}

/** RFC 4519 `uid`, which is where Apple puts the pass type identifier. */
const UID_OID = "0.9.2342.19200300.100.1.1";

/**
 * The pass type identifier a certificate was issued for.
 *
 * node-forge has no short name for the `uid` attribute, so `getField("UID")`
 * returns nothing on a real Apple certificate -- verified against one. Read it
 * by OID instead, and fall back to the common name, which Apple formats as
 * "Pass Type ID: <identifier>".
 */
function passTypeOf(cert) {
  const uid = cert.subject.attributes.find((attribute) => attribute.type === UID_OID);
  if (uid?.value) return uid.value;
  const cn = subjectField(cert, "CN");
  return /^Pass Type ID: (.+)$/.exec(cn ?? "")?.[1] ?? null;
}

/** The WWDR generation a certificate was issued under, e.g. "G4". */
function wwdrGeneration(cert) {
  return cert.issuer.getField("OU")?.value ?? null;
}

/**
 * Apple publishes each generation of the WWDR intermediate at a predictable
 * URL, and the one bundled in a pass has to be the generation that signed the
 * pass certificate -- mixing them produces a pass iOS silently rejects.
 */
async function fetchWwdr(generation) {
  const file = generation ? `AppleWWDRCA${generation}.cer` : "AppleWWDRCA.cer";
  let res;
  try {
    res = await fetch(`${CERT_AUTHORITY}/${file}`);
  } catch (error) {
    return fail(`couldn't reach ${CERT_AUTHORITY} to download ${file} (${error.cause?.code ?? error.message}). Download it by hand from ${CERT_AUTHORITY} and pass it as ${DEFAULT_DIR}/wwdr.pem.`);
  }
  if (!res.ok) {
    fail(`couldn't download ${file}: ${res.status}. Fetch it by hand from ${CERT_AUTHORITY} instead.`);
  }
  const der = new Uint8Array(await res.arrayBuffer());
  return parseCertificate(der, file);
}

/** Accepts either DER (Apple's `.cer` download) or PEM. */
function parseCertificate(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  try {
    if (text.includes("-----BEGIN CERTIFICATE-----")) {
      return forge.pki.certificateFromPem(text);
    }
    const binary = forge.util.createBuffer(Buffer.from(bytes).toString("binary"));
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(binary));
  } catch (error) {
    return fail(`couldn't read ${label} as a certificate: ${error.message}`);
  }
}

function sameKeyPair(cert, privateKey) {
  return cert.publicKey.n.toString(16) === privateKey.n.toString(16);
}

function daysUntil(date) {
  return Math.floor((date.getTime() - Date.now()) / DAY_MS);
}

function reportVerdict(daysRemaining) {
  const verdict = expiryVerdict(daysRemaining);
  if (!verdict || typeof verdict.level !== "string") {
    fail("expiryVerdict() returned nothing usable -- see the TODO in this script");
  }
  const line = `${verdict.level.toUpperCase()}: ${verdict.message}`;
  if (verdict.level === "ok") {
    console.log(line);
    return;
  }
  console.error(line);
  process.exitCode = 1;
}

// --- csr ---------------------------------------------------------------

function commandCsr(dir) {
  mkdirSync(dir, { recursive: true });
  // 2048-bit RSA: what Apple issues these against, and what the signer expects.
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  // Apple takes the identity from the Pass Type ID being renewed rather than
  // from this subject, but a CSR still has to carry one.
  csr.setSubject([
    { name: "commonName", value: "Los Verdes Pass Type ID" },
    { name: "organizationName", value: "Los Verdes" },
    { name: "countryName", value: "US" },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const keyPath = join(dir, "pass-key.pem");
  const csrPath = join(dir, "pass.csr");
  // PKCS#8, unencrypted: node-forge cannot read a passphrase-protected key,
  // and this value goes into a Worker secret where there is nothing to unlock
  // it with.
  writeFileSync(keyPath, forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))));
  writeFileSync(csrPath, forge.pki.certificationRequestToPem(csr));

  console.log(`Wrote ${keyPath} and ${csrPath}`);
  console.log("");
  console.log("Now, in Apple's console (this part cannot be automated -- the App");
  console.log("Store Connect API does not cover Pass Type ID certificates):");
  console.log("");
  console.log("  1. https://developer.apple.com/account/resources/certificates");
  console.log("  2. Add a certificate, of type Pass Type ID Certificate.");
  console.log("  3. Choose the EXISTING pass type identifier -- do not create a new");
  console.log("     one. Passes already in members' wallets are tied to it.");
  console.log(`  4. Upload ${csrPath}, then download the .cer Apple returns.`);
  console.log("");
  console.log("Then install it:");
  console.log("");
  console.log("  just apple-pass-cert-install staging ~/Downloads/pass.cer");
  console.log("");
  console.log(`Keep ${keyPath} until then: Apple never sees the private key, so a`);
  console.log("certificate without it is useless and the CSR has to be redone.");
}

// --- install -----------------------------------------------------------

async function commandInstall(cerPath, dir, env) {
  const { passTypeId, teamId } = passIdentifiers(env);
  const leaf = parseCertificate(readFileSync(cerPath), cerPath);

  const uid = passTypeOf(leaf);
  const ou = subjectField(leaf, "OU");
  if (uid !== passTypeId) {
    fail(`${cerPath} is for pass type "${uid}", but ${env} issues "${passTypeId}". Wrong certificate downloaded?`);
  }
  if (ou !== teamId) {
    fail(`${cerPath} is for team "${ou}", but ${env} expects "${teamId}".`);
  }

  const keyPath = join(dir, "pass-key.pem");
  let privateKey;
  try {
    privateKey = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8"));
  } catch (error) {
    return fail(`couldn't read the private key at ${keyPath}: ${error.message}. It has to be the one whose CSR Apple signed.`);
  }
  if (!sameKeyPair(leaf, privateKey)) {
    fail(`${cerPath} does not match the private key at ${keyPath} -- signing would produce passes nothing can verify.`);
  }

  const generation = wwdrGeneration(leaf);
  const wwdr = await fetchWwdr(generation);
  const caStore = forge.pki.createCaStore([wwdr]);
  try {
    // `verifyCertificateChain` walks to a trusted root; WWDR is an
    // intermediate, so trusting it directly is the partial-chain equivalent of
    // `openssl verify -partial_chain`.
    forge.pki.verifyCertificateChain(caStore, [leaf]);
  } catch (error) {
    fail(`the certificate does not verify against WWDR ${generation}: ${error.message ?? error}`);
  }

  const certPath = join(dir, "pass-cert.pem");
  const wwdrPath = join(dir, "wwdr.pem");
  writeFileSync(certPath, forge.pki.certificateToPem(leaf));
  writeFileSync(wwdrPath, forge.pki.certificateToPem(wwdr));

  const remaining = daysUntil(leaf.validity.notAfter);
  console.log(`Pass type:   ${uid} (team ${ou})`);
  console.log(`Issued by:   WWDR ${generation}`);
  console.log(`Valid until: ${leaf.validity.notAfter.toISOString().slice(0, 10)} (${remaining} days)`);
  console.log(`Key matches the certificate, and the certificate verifies against WWDR ${generation}.`);
  console.log("");
  console.log(`Wrote ${certPath}, ${keyPath} and ${wwdrPath}.`);
  reportVerdict(remaining);
}

// --- check -------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function itemField(item, label) {
  return item.fields?.find((field) => field.label === label)?.value ?? null;
}

async function commandCheck(env) {
  let item;
  try {
    item = JSON.parse(await readStdin());
  } catch {
    return fail("expected the 1Password item as JSON on stdin (did `op item get` fail?)");
  }

  const certPem = itemField(item, "APPLE_PASS_CERT_PEM");
  const wwdrPem = itemField(item, "APPLE_WWDR_CERT_PEM");
  const keyPem = itemField(item, "APPLE_PASS_KEY_PEM");
  if (!certPem) fail(`1Password item "${item.title}" has no APPLE_PASS_CERT_PEM`);

  const { passTypeId } = passIdentifiers(env);
  const leaf = parseCertificate(Buffer.from(certPem, "utf8"), "APPLE_PASS_CERT_PEM");
  const uid = passTypeOf(leaf);
  const generation = wwdrGeneration(leaf);
  const remaining = daysUntil(leaf.validity.notAfter);

  console.log(`Apple pass certificate for ${env} (1Password item "${item.title}"):`);
  console.log(`  Pass type:   ${uid}${uid === passTypeId ? "" : `   !! wrangler.toml says ${passTypeId}`}`);
  console.log(`  Issued by:   WWDR ${generation}`);
  console.log(`  Valid:       ${leaf.validity.notBefore.toISOString().slice(0, 10)} to ${leaf.validity.notAfter.toISOString().slice(0, 10)}`);

  if (keyPem) {
    let matches = false;
    try {
      matches = sameKeyPair(leaf, forge.pki.privateKeyFromPem(keyPem));
    } catch {
      matches = false;
    }
    console.log(`  Key:         ${matches ? "matches the certificate" : "!! does NOT match the certificate"}`);
    if (!matches) process.exitCode = 1;
  } else {
    console.log("  Key:         !! APPLE_PASS_KEY_PEM is missing");
    process.exitCode = 1;
  }

  if (wwdrPem) {
    const wwdr = parseCertificate(Buffer.from(wwdrPem, "utf8"), "APPLE_WWDR_CERT_PEM");
    const storedGeneration = wwdr.subject.getField("OU")?.value ?? null;
    const right = storedGeneration === generation;
    console.log(`  WWDR:        ${storedGeneration}${right ? " (matches)" : `   !! certificate was issued under ${generation}`}`);
    if (!right) process.exitCode = 1;
  } else {
    console.log("  WWDR:        !! APPLE_WWDR_CERT_PEM is missing");
    process.exitCode = 1;
  }

  reportVerdict(remaining);
}

// --- arguments ---------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const at = rest.indexOf(name);
  return at === -1 ? fallback : rest[at + 1];
};
const positional = rest.filter((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--"));
const dir = flagValue("--dir", DEFAULT_DIR);
const env = flagValue("--env", "production");
if (!ENVIRONMENTS.includes(env)) fail(`--env must be one of: ${ENVIRONMENTS.join(", ")}`);

switch (command) {
  case "csr":
    commandCsr(dir);
    break;
  case "install":
    if (!positional[0]) fail("install needs the path to the .cer Apple gave you");
    await commandInstall(positional[0], dir, env);
    break;
  case "check":
    await commandCheck(env);
    break;
  default:
    fail("first argument must be csr, install or check");
}
