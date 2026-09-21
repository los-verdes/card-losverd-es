/**
 * Independent validation of the PKCS#7 detached signature this codebase
 * produces, using `openssl smime -verify` rather than a round-trip unit test:
 * a subtly-wrong ASN.1/PKCS7 structure can satisfy a test that verifies with
 * the same library that signed, while still being malformed to everything
 * else -- including iOS, which simply refuses the pass with no explanation.
 *
 * Originally written for the Phase 1.0.1 risk spike (PR #2). It now exercises
 * the real signer, `src/passkit/signer.ts`, with the same throwaway
 * certificate chain the tests use.
 *
 * This has to run under plain Node rather than vitest-pool-workers/workerd,
 * because it shells out to the `openssl` binary and `child_process` isn't part
 * of the `nodejs_compat` surface inside a Worker. The signing code is portable
 * TypeScript with no Workers-only APIs, so it behaves identically either way.
 *
 * Usage: `just verify-pkcs7-openssl` (requires `openssl` on PATH).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, buildPassJson } from '../src/passkit/generator';
import { signManifestDetached } from '../src/passkit/signer';
import { getTestCertChain } from '../test/fixtures/certChain';

const MEMBER = {
  memberId: 'LV-00000000-0000-4000-8000-000000000000',
  firstName: 'Casey',
  lastName: 'Example',
  status: 'active' as const,
  expirationDate: '2099-02-17',
  memberSince: '2021-07-01',
  authToken: 'not-a-real-auth-token',
  verifyUrl: 'https://card.losverd.es/verify-pass/LV-00000000-0000-4000-8000-000000000000?signature=x',
};

const CONFIG = {
  passTypeIdentifier: 'pass.es.losverd.card',
  teamIdentifier: 'KJHZP635V9',
  organizationName: 'Los Verdes',
  webServiceURL: 'https://card.losverd.es/passkit',
};

async function main() {
  const { leafCertPem, leafPrivateKeyPem, rootCertPem } = getTestCertChain();

  // A minimal bundle: the manifest covers whatever files are in it, and the
  // signature covers the manifest, so one file is enough to exercise both.
  const files = { 'pass.json': buildPassJson(MEMBER, CONFIG) };
  const manifestBytes = await buildManifest(files);

  const startedAt = performance.now();
  const signatureDer = signManifestDetached(manifestBytes, {
    signingCertPem: leafCertPem,
    signingKeyPem: leafPrivateKeyPem,
    // Stands in for Apple's WWDR intermediate, which is what a real bundle
    // carries here.
    wwdrCertPem: rootCertPem,
  });
  const signMs = performance.now() - startedAt;

  console.log(`PKCS#7 sign() took ${signMs.toFixed(2)}ms`);
  console.log(`manifest.json: ${manifestBytes.length} bytes`);
  console.log(`signature (DER): ${signatureDer.length} bytes`);

  const dir = mkdtempSync(join(tmpdir(), 'pkcs7-verify-'));
  const manifestPath = join(dir, 'manifest.json');
  const signaturePath = join(dir, 'signature.der');
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(signaturePath, signatureDer);

  console.log(`Wrote ${manifestPath} and ${signaturePath}`);
  console.log('Running: openssl smime -verify -noverify -in signature.der -inform DER -content manifest.json');

  try {
    const output = execFileSync(
      'openssl',
      ['smime', '-verify', '-noverify', '-in', signaturePath, '-inform', 'DER', '-content', manifestPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log('--- openssl stdout (verified content) ---');
    console.log(output);
    console.log('RESULT: openssl accepted the PKCS#7 structure (Verification successful).');
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    console.error('RESULT: openssl REJECTED the PKCS#7 structure.');
    console.error('exit code:', e.status);
    console.error('stdout:', e.stdout?.toString());
    console.error('stderr:', e.stderr?.toString());
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
