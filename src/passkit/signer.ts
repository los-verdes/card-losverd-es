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
 * Phase 1.0.1 risk spike (PR #2), which established that node-forge can
 * produce a structurally valid detached signature inside workerd at all; the
 * spike itself has since been retired, its throwaway certificate generator
 * kept on as `test/fixtures/certChain.ts`.
 *
 * A round-trip unit test can pass against a subtly malformed ASN.1/PKCS7
 * structure, so correctness here is checked from outside as well:
 * `just verify-pkcs7-openssl` signs a bundle with this function and hands the
 * result to `openssl smime -verify`.
 *
 * The function takes any valid PEM cert/key triple, so tests drive it with a
 * self-signed chain while production passes the real Apple-issued Pass Type ID
 * certificate and WWDR intermediate.
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
