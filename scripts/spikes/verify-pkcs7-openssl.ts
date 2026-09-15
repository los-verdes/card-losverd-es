/**
 * Phase 1.0.1 risk-spike: independent validation of the PKCS#7 detached
 * signature this codebase produces, using `openssl smime -verify` rather
 * than a round-trip unit test -- the migration plan explicitly calls out
 * that a subtly-wrong ASN.1/PKCS7 structure can pass a naive unit test while
 * still being malformed, so this step matters.
 *
 * This has to run under plain Node (not vitest-pool-workers/workerd) because
 * it shells out to the `openssl` binary, and `child_process` isn't part of
 * the `nodejs_compat` surface available inside a Worker/vitest-pool-workers
 * sandbox. The signing code under test (src/spikes/pkcs7-signing/*) is
 * otherwise plain portable TS with no Workers-only APIs, so it runs
 * identically here as it does under workerd.
 *
 * Usage: node scripts/spikes/verify-pkcs7-openssl.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDummyAssetFiles, buildManifest, buildPassJson } from '../../src/spikes/pkcs7-signing/pass.ts';
import { signManifestDetached } from '../../src/spikes/pkcs7-signing/signer.ts';

async function main() {
  const passJson = buildPassJson();
  const assetFiles = buildDummyAssetFiles();
  const files = { 'pass.json': passJson, ...assetFiles };

  const manifestBytes = await buildManifest(files);
  const { signatureDer, signMs } = signManifestDetached(manifestBytes);

  console.log(`PKCS#7 sign() took ${signMs.toFixed(2)}ms`);
  console.log(`manifest.json: ${manifestBytes.length} bytes`);
  console.log(`signature (DER): ${signatureDer.length} bytes`);

  const dir = mkdtempSync(join(tmpdir(), 'pkcs7-spike-'));
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
