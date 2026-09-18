import { describe, expect, it } from "vitest";
import { getTestCertChain } from "../fixtures/certChain";
import { signManifestDetached } from "../../src/passkit/signer";

function testCredentials() {
  const chain = getTestCertChain();
  return {
    signingCertPem: chain.leafCertPem,
    signingKeyPem: chain.leafPrivateKeyPem,
    wwdrCertPem: chain.rootCertPem,
  };
}

describe("signManifestDetached", () => {
  it("produces a non-trivial detached PKCS#7 signature (DER SEQUENCE) over the given bytes", () => {
    const manifestBytes = new TextEncoder().encode('{"pass.json":"deadbeef"}');

    const signatureDer = signManifestDetached(manifestBytes, testCredentials());

    expect(signatureDer.length).toBeGreaterThan(500);
    expect(signatureDer[0]).toBe(0x30); // DER SEQUENCE tag
  });

  it("produces different signatures for different manifest content", () => {
    const credentials = testCredentials();
    const a = signManifestDetached(
      new TextEncoder().encode('{"pass.json":"aaaa"}'),
      credentials,
    );
    const b = signManifestDetached(
      new TextEncoder().encode('{"pass.json":"bbbb"}'),
      credentials,
    );

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("throws on a malformed certificate PEM rather than signing silently", () => {
    const credentials = testCredentials();
    expect(() =>
      signManifestDetached(new TextEncoder().encode("x"), {
        ...credentials,
        signingCertPem: "not a real PEM",
      }),
    ).toThrow();
  });
});
