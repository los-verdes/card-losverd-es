import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTestCertChain } from '../../src/spikes/pkcs7-signing/certs';
import { buildDummyAssetFiles, buildManifest, buildPassJson, sha1Hex } from '../../src/spikes/pkcs7-signing/pass';
import { signManifestDetached } from '../../src/spikes/pkcs7-signing/signer';

describe('Phase 1.0.1 spike: PKCS#7 pass signing', () => {
  it('builds a manifest.json with SHA-1 hashes for every bundle file', async () => {
    const passJson = buildPassJson();
    const assetFiles = buildDummyAssetFiles();
    const files = { 'pass.json': passJson, ...assetFiles };

    const manifestBytes = await buildManifest(files);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

    expect(Object.keys(manifest).sort()).toEqual(
      ['icon.png', 'icon@2x.png', 'logo.png', 'pass.json'].sort(),
    );
    // manifest hashes must match independently-computed SHA-1 hex digests
    for (const [name, bytes] of Object.entries(files)) {
      expect(manifest[name]).toBe(await sha1Hex(bytes));
    }
    // SHA-1 hex digest is 40 chars
    expect(manifest['pass.json']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces a self-signed test cert chain usable for signing', () => {
    const chain = getTestCertChain();
    expect(chain.rootCertPem).toContain('BEGIN CERTIFICATE');
    expect(chain.leafCertPem).toContain('BEGIN CERTIFICATE');
    expect(chain.leafPrivateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    // memoized -- repeated calls return the same chain instance
    expect(getTestCertChain()).toBe(chain);
  });

  it('produces a detached PKCS#7 signature over the manifest', async () => {
    const passJson = buildPassJson();
    const assetFiles = buildDummyAssetFiles();
    const files = { 'pass.json': passJson, ...assetFiles };
    const manifestBytes = await buildManifest(files);

    const { signatureDer, signMs } = signManifestDetached(manifestBytes);

    // Non-trivial DER output (a real signature, not an empty/placeholder value).
    expect(signatureDer.length).toBeGreaterThan(500);
    // DER SEQUENCE tag
    expect(signatureDer[0]).toBe(0x30);

    // Sanity data point for Phase 1.0.1 step 4 (CPU-time budget) -- printed
    // rather than asserted on, since exact timing is host-dependent.
    // eslint-disable-next-line no-console
    console.log(`[pkcs7-signing spike] manifest sign() took ${signMs.toFixed(2)}ms`);
    expect(signMs).toBeGreaterThan(0);
  });

  it('round-trips end to end through the mounted Worker route', async () => {
    const res = await SELF.fetch('https://example.com/spikes/pkcs7-signing');
    expect(res.status).toBe(200);
    const body = await res.json<{
      manifest: Record<string, string>;
      signatureBase64: string;
      signMs: number;
      rootCertPem: string;
      leafCertPem: string;
    }>();

    expect(body.manifest['pass.json']).toMatch(/^[0-9a-f]{40}$/);
    expect(body.signatureBase64.length).toBeGreaterThan(0);
    expect(body.rootCertPem).toContain('BEGIN CERTIFICATE');
    expect(body.leafCertPem).toContain('BEGIN CERTIFICATE');
  });
});
