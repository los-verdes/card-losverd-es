import forge from 'node-forge';
import { inject } from 'vitest';

/**
 * A throwaway certificate chain for tests.
 *
 * Apple pass signing needs a Pass Type ID certificate and Apple's WWDR
 * intermediate. Tests can't use the real ones -- they're Worker secrets, and
 * a repository is the wrong place for a signing key -- so this generates a
 * self-signed root CA and leaf in their place. `signManifestDetached()` takes
 * any valid PEM triple, so the code path under test is the production one;
 * what isn't tested here is that the chain is trusted by Apple, which only a
 * real device install can show.
 *
 * Generated once per test run, in `test/setup/global.ts`, and handed to every
 * file through Vitest's `provide`/`inject`. Each file runs in its own isolated
 * worker, so memoizing here alone meant every file that signed a pass built
 * its own pair of 2048-bit RSA keys -- in pure JavaScript, eight times per
 * run, and most of the time a short spec spent. A file run on its own, with
 * no global setup, still builds a chain for itself.
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
    { name: 'organizationName', value: 'Los Verdes (test only -- not a real org cert)' },
  ];
}

/**
 * Generates (and memoizes) a throwaway self-signed root CA + leaf cert.
 * Memoized because a real deployment loads its Apple-issued cert chain once
 * from Worker secrets rather than regenerating it per request -- Phase 4.6's
 * actual per-request hot path is only the PKCS#7 *signing* step (see
 * src/passkit/signer.ts), not certificate generation.
 */
export function getTestCertChain(): TestCertChain {
  if (cached) {
    return cached;
  }
  // `inject` throws outside a Vitest worker, and returns undefined when the
  // global setup provided nothing -- either way, build one here instead.
  try {
    const provided = inject('testCertChain');
    if (provided) {
      cached = provided;
      return cached;
    }
  } catch {
    // Not running under Vitest's global setup.
  }
  cached = buildTestCertChain();
  return cached;
}

/**
 * The chain itself: a self-signed root and a leaf it signed. Separate from
 * `getTestCertChain` so the global setup can build it in Node, once, where
 * there is nothing to inject from.
 */
export function buildTestCertChain(): TestCertChain {
  const rootKeys = forge.pki.rsa.generateKeyPair(2048);
  const rootCert = forge.pki.createCertificate();
  rootCert.publicKey = rootKeys.publicKey;
  rootCert.serialNumber = '01';
  rootCert.validity.notBefore = new Date();
  rootCert.validity.notAfter = new Date();
  rootCert.validity.notAfter.setFullYear(rootCert.validity.notBefore.getFullYear() + 1);
  const rootAttrs = commonAttrs('Test Root CA (not a real certificate authority)');
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
  leafCert.setSubject(commonAttrs('Test Leaf (stand-in for a Pass Type ID cert)'));
  leafCert.setIssuer(rootAttrs);
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, critical: true },
  ]);
  leafCert.sign(rootKeys.privateKey, forge.md.sha256.create());

  return {
    rootCertPem: forge.pki.certificateToPem(rootCert),
    leafCertPem: forge.pki.certificateToPem(leafCert),
    leafPrivateKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}
