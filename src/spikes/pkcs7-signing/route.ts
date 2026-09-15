import { Hono } from 'hono';
import { getTestCertChain } from './certs';
import { buildDummyAssetFiles, buildManifest, buildPassJson } from './pass';
import { signManifestDetached } from './signer';

/**
 * Phase 1.0.1 risk spike: PKCS#7 pass signing on Cloudflare Workers.
 *
 * This is throwaway/spike code -- see the migration plan
 * (.ai/gcp-to-cf_plan.md, Phase 1.0.1 and Phase 4.6) and the PR description
 * for the feasibility verdict and required human follow-ups (real Apple
 * cert chain, real-device Wallet install). It is intentionally NOT mounted
 * as a production pass-serving endpoint -- it exists to manually exercise
 * the signing pipeline end-to-end via `just dev` and to back the vitest spec
 * in test/spikes/pkcs7-signing.spec.ts.
 */
export const pkcs7SigningSpike = new Hono();

pkcs7SigningSpike.get('/', async (c) => {
  const passJson = buildPassJson();
  const assetFiles = buildDummyAssetFiles();
  const files = { 'pass.json': passJson, ...assetFiles };

  const manifestBytes = await buildManifest(files);
  const { signatureDer, signMs } = signManifestDetached(manifestBytes);
  const { rootCertPem, leafCertPem } = getTestCertChain();

  return c.json({
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
    signatureBase64: btoa(String.fromCharCode(...signatureDer)),
    signMs,
    rootCertPem,
    leafCertPem,
    note:
      'Throwaway self-signed test chain -- NOT a real Apple Pass Type ID cert / WWDR ' +
      'chain. Structural validity only; see PR description for what still needs a ' +
      'human with real Apple Developer credentials.',
  });
});
