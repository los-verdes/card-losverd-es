/**
 * Phase 1.0.1 risk-spike support code: builds a trivial pass bundle
 * (pass.json + a couple of dummy asset files) and the SHA-1 manifest.json
 * that Apple's pass format requires, entirely with Web Crypto (available on
 * Workers without any extra dependency).
 */
export type PassBundleFiles = Record<string, Uint8Array>;

// A minimal valid 1x1 transparent PNG, used as a stand-in for icon.png /
// icon@2x.png / logo.png -- real pass content is out of scope for this spike
// (see Phase 1.0.2 for the actual card-image-rendering pipeline).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function buildPassJson(): Uint8Array {
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: 'pass.es.losverd.spike',
    serialNumber: 'SPIKE-0001',
    teamIdentifier: 'SPIKE1234',
    organizationName: 'Los Verdes (PKCS7 signing spike)',
    description: 'Throwaway pass used only to validate PKCS7 signing on Workers',
    generic: {
      primaryFields: [{ key: 'member', label: 'MEMBER', value: 'Spike Testerson' }],
    },
  };
  return new TextEncoder().encode(JSON.stringify(pass));
}

export function buildDummyAssetFiles(): PassBundleFiles {
  const icon = base64ToBytes(TINY_PNG_BASE64);
  return {
    'icon.png': icon,
    'icon@2x.png': icon,
    'logo.png': icon,
  };
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Builds manifest.json: { filename: sha1Hex } for every file in the bundle. */
export async function buildManifest(files: PassBundleFiles): Promise<Uint8Array> {
  const manifest: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    manifest[name] = await sha1Hex(bytes);
  }
  return new TextEncoder().encode(JSON.stringify(manifest));
}
