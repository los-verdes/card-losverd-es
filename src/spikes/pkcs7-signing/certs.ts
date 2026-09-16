import forge from 'node-forge';

/**
 * Phase 1.0.1 risk-spike support code.
 *
 * There is no real Apple Pass Type ID certificate / WWDR chain available in
 * this environment, so this module generates a throwaway, self-signed
 * root CA + leaf certificate chain using node-forge. The point of this spike
 * is validating that the PKCS#7 ASN.1 structure this Worker produces is
 * well-formed -- NOT that it chains to Apple's real WWDR root. See the PR
 * description for what real-cert-chain validation still needs to happen (by
 * a human, with real Apple Developer credentials) before Phase 4.6.
 */
export interface TestCertChain {
  rootCertPem: string;
  leafCertPem: string;
  leafPrivateKeyPem: string;
}

let cached: TestCertChain | undefined;

function commonAttrs(commonName: string): forge.pki.CertificateField[] {
  return [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Los Verdes (spike/test only -- not a real org cert)' },
  ];
}

/**
 * Generates (and memoizes) a throwaway self-signed root CA + leaf cert.
 * Memoized because a real deployment loads its Apple-issued cert chain once
 * from Worker secrets rather than regenerating it per request -- Phase 4.6's
 * actual per-request hot path is only the PKCS#7 *signing* step (see
 * signer.ts), not certificate generation.
 */
export function getTestCertChain(): TestCertChain {
  if (cached) {
    return cached;
  }

  const rootKeys = forge.pki.rsa.generateKeyPair(2048);
  const rootCert = forge.pki.createCertificate();
  rootCert.publicKey = rootKeys.publicKey;
  rootCert.serialNumber = '01';
  rootCert.validity.notBefore = new Date();
  rootCert.validity.notAfter = new Date();
  rootCert.validity.notAfter.setFullYear(rootCert.validity.notBefore.getFullYear() + 1);
  const rootAttrs = commonAttrs('PKCS7 Spike Test Root CA');
  rootCert.setSubject(rootAttrs);
  rootCert.setIssuer(rootAttrs);
  rootCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  rootCert.sign(rootKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date();
  leafCert.validity.notAfter.setFullYear(leafCert.validity.notBefore.getFullYear() + 1);
  leafCert.setSubject(commonAttrs('PKCS7 Spike Test Leaf (stand-in for a Pass Type ID cert)'));
  leafCert.setIssuer(rootAttrs);
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, critical: true },
  ]);
  leafCert.sign(rootKeys.privateKey, forge.md.sha256.create());

  cached = {
    rootCertPem: forge.pki.certificateToPem(rootCert),
    leafCertPem: forge.pki.certificateToPem(leafCert),
    leafPrivateKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
  return cached;
}
