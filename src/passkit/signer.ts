import forge from "node-forge";

export interface PassSigningCredentials {
  /** PEM-encoded Apple Pass Type ID certificate (the "leaf" cert). */
  signingCertPem: string;
  /** PEM-encoded private key matching `signingCertPem`. */
  signingKeyPem: string;
  /** PEM-encoded Apple WWDR (Worldwide Developer Relations) intermediate certificate. */
  wwdrCertPem: string;
}

/**
 * Produces a PKCS#7 **detached** signature over `manifestBytes` (the
 * `.pkpass` bundle's `manifest.json`), per Phase 4.6. Promoted from the
 * Phase 1.0.1 spike (`src/spikes/pkcs7-signing/signer.ts`, see PR #2) -- the
 * ASN.1/PKCS7 structure this produces was independently verified there via
 * `openssl smime -verify`. The one thing that changes here versus the spike:
 * real Apple-issued certificates (Pass Type ID cert + WWDR intermediate) are
 * passed in rather than a throwaway self-signed chain generated in-process.
 *
 * Real Apple Pass Type ID + WWDR certificates aren't available in this
 * environment yet (see the migration plan's Phase 0.2 credential inventory)
 * -- this function works against any valid PEM cert/key triple (including
 * `getTestCertChain()`'s spike certs) so it's fully testable today, and
 * becomes end-to-end real the moment those secrets are populated. No code
 * change needed when that happens.
 */
export function signManifestDetached(
  manifestBytes: Uint8Array,
  credentials: PassSigningCredentials,
): Uint8Array {
  const signingCert = forge.pki.certificateFromPem(credentials.signingCertPem);
  const wwdrCert = forge.pki.certificateFromPem(credentials.wwdrCertPem);
  const signingKey = forge.pki.privateKeyFromPem(credentials.signingKeyPem);

  const manifestForgeBytes = forge.util.binary.raw.encode(manifestBytes);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestForgeBytes);
  p7.addCertificate(signingCert);
  p7.addCertificate(wwdrCert);
  p7.addSigner({
    key: signingKey,
    certificate: signingCert,
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

  p7.sign({ detached: true });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.binary.raw.decode(der);
}
