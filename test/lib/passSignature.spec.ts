import { describe, expect, it } from "vitest";
import { buildVerifyPassUrl, signPassSerial, verifyPassSerialSignature } from "../../src/lib/passSignature";

// Cross-checked against the legacy Python implementation
// (base64.urlsafe_b64encode(hmac.new(key, msg, sha256).digest())); see
// docs/legacy-pass-compatibility.md.
const LEGACY_KEY = "test-secret-key-abc".repeat(5);
const LEGACY_MESSAGE = "0cd5ad745fbc40fd9569747fec277013";
const LEGACY_SIGNATURE = "x_td-tSCx3v0XBxKhhIrhJwPOBn6f7blXnFwhpYIzcM=";

describe("signPassSerial", () => {
  it("matches the legacy app's URL-safe, padded HMAC-SHA256 signature byte for byte", async () => {
    expect(await signPassSerial(LEGACY_KEY, LEGACY_MESSAGE)).toBe(LEGACY_SIGNATURE);
  });

  it("fails closed without a key", async () => {
    await expect(signPassSerial("", "serial")).rejects.toThrow(/PASS_SIGNATURE_KEY/);
  });
});

describe("verifyPassSerialSignature", () => {
  it("accepts the legacy signature", async () => {
    expect(await verifyPassSerialSignature(LEGACY_KEY, LEGACY_MESSAGE, LEGACY_SIGNATURE)).toBe(true);
  });

  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["empty", ""],
    ["plain (non-URL-safe) base64 of the same bytes", LEGACY_SIGNATURE.replace(/-/g, "+").replace(/_/g, "/")],
    ["unpadded", LEGACY_SIGNATURE.replace(/=+$/, "")],
  ])("rejects a %s signature", async (_label, signature) => {
    expect(await verifyPassSerialSignature(LEGACY_KEY, LEGACY_MESSAGE, signature)).toBe(false);
  });

  it("rejects a genuine signature for a different serial", async () => {
    const other = await signPassSerial(LEGACY_KEY, "some-other-serial");
    expect(await verifyPassSerialSignature(LEGACY_KEY, LEGACY_MESSAGE, other)).toBe(false);
  });
});

describe("buildVerifyPassUrl", () => {
  it("builds /verify-pass/:serial with a signature that verifies after URL parsing", async () => {
    const url = new URL(await buildVerifyPassUrl("https://card.losverd.es", LEGACY_KEY, LEGACY_MESSAGE));

    expect(url.origin + url.pathname).toBe(`https://card.losverd.es/verify-pass/${LEGACY_MESSAGE}`);
    expect(url.searchParams.get("signature")).toBe(LEGACY_SIGNATURE);
  });

  it("percent-encodes the serial path segment", async () => {
    const url = await buildVerifyPassUrl("https://card.losverd.es", LEGACY_KEY, "a/b");
    expect(url).toMatch(/^https:\/\/card\.losverd\.es\/verify-pass\/a%2Fb\?signature=/);
  });
});
