import forge from 'node-forge';
import { getTestCertChain } from './certs';

export interface SignResult {
  /** Raw DER bytes of the detached PKCS#7 SignedData -- this is exactly the
   * byte layout that goes into a `.pkpass` bundle's `signature` file. */
  signatureDer: Uint8Array;
  /** Wall-clock time (ms) spent in the actual PKCS#7 sign() call, as a rough
   * CPU-budget sanity data point for Phase 1.0.1 step 4. */
  signMs: number;
}

/**
 * Produces a PKCS#7 **detached** signature over `manifestBytes`, mirroring
 * the structure Apple's Wallet expects at `signature` inside a .pkpass
 * bundle (see Phase 4.6 of the migration plan). Uses the throwaway
 * self-signed test chain from certs.ts rather than a real Apple Pass Type ID
 * cert / WWDR chain -- this only validates ASN.1/PKCS7 structural
 * correctness (see openssl verification in scripts/spikes/), not that the
 * chain is trusted by a real device.
 */
export function signManifestDetached(manifestBytes: Uint8Array): SignResult {
  const { rootCertPem, leafCertPem, leafPrivateKeyPem } = getTestCertChain();

  const rootCert = forge.pki.certificateFromPem(rootCertPem);
  const leafCert = forge.pki.certificateFromPem(leafCertPem);
  const leafPrivateKey = forge.pki.privateKeyFromPem(leafPrivateKeyPem);

  const manifestForgeBytes = forge.util.binary.raw.encode(manifestBytes);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestForgeBytes);
  p7.addCertificate(leafCert);
  p7.addCertificate(rootCert);
  p7.addSigner({
    key: leafPrivateKey,
    certificate: leafCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      // @types/node-forge types this as `string`, but forge's runtime
      // implementation special-cases the signingTime attribute to accept a
      // Date directly (see forge/lib/pkcs7.js) -- the type declaration is
      // just incomplete here.
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });

  const start = performance.now();
  p7.sign({ detached: true });
  const signMs = performance.now() - start;

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const signatureDer = forge.util.binary.raw.decode(der);

  return { signatureDer, signMs };
}
