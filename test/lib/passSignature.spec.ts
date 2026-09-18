import { describe, expect, it } from "vitest";
import {
  buildVerifyPassUrl,
  passSignatureKeys,
  signPassSerial,
  verifyPassSerialSignature,
} from "../../src/lib/passSignature";

// Cross-checked against the legacy Python implementation
// (base64.urlsafe_b64encode(hmac.new(key, msg, sha256).digest())); see
// docs/legacy-pass-compatibility.md.
const LEGACY_KEY = "test-secret-key-abc".repeat(5);
const LEGACY_MESSAGE = "0cd5ad745fbc40fd9569747fec277013";
const LEGACY_SIGNATURE = "x_td-tSCx3v0XBxKhhIrhJwPOBn6f7blXnFwhpYIzcM=";
const ROTATED_KEY = "rotated-secret-key-xyz".repeat(5);

describe("signPassSerial", () => {
  it("matches the legacy app's URL-safe, padded HMAC-SHA256 signature byte for byte", async () => {
    expect(await signPassSerial(LEGACY_KEY, LEGACY_MESSAGE)).toBe(LEGACY_SIGNATURE);
  });

  it("fails closed without a key", async () => {
    await expect(signPassSerial("", "serial")).rejects.toThrow(/PASS_SIGNATURE_KEY/);
  });
});

describe("passSignatureKeys", () => {
  it("has no previous key outside a rotation", () => {
    expect(passSignatureKeys({ PASS_SIGNATURE_KEY: LEGACY_KEY })).toEqual({ current: LEGACY_KEY });
  });

  it("carries the previous key during a rotation", () => {
    expect(
      passSignatureKeys({
        PASS_SIGNATURE_KEY: ROTATED_KEY,
        PASS_SIGNATURE_KEY_PREVIOUS: LEGACY_KEY,
      }),
    ).toEqual({ current: ROTATED_KEY, previous: LEGACY_KEY });
  });

  it.each([
    ["empty", ""],
    ["a duplicate of the current key", LEGACY_KEY],
  ])("ignores %s previous key, so old codes aren't reported as still circulating", (_label, previous) => {
    expect(
      passSignatureKeys({
        PASS_SIGNATURE_KEY: LEGACY_KEY,
        PASS_SIGNATURE_KEY_PREVIOUS: previous,
      }),
    ).toEqual({ current: LEGACY_KEY });
  });
});

describe("verifyPassSerialSignature", () => {
  it("accepts the legacy signature", async () => {
    expect(
      await verifyPassSerialSignature({ current: LEGACY_KEY }, LEGACY_MESSAGE, LEGACY_SIGNATURE),
    ).toBe("current");
  });

  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["empty", ""],
    ["plain (non-URL-safe) base64 of the same bytes", LEGACY_SIGNATURE.replace(/-/g, "+").replace(/_/g, "/")],
    ["unpadded", LEGACY_SIGNATURE.replace(/=+$/, "")],
  ])("rejects a %s signature", async (_label, signature) => {
    expect(await verifyPassSerialSignature({ current: LEGACY_KEY }, LEGACY_MESSAGE, signature)).toBeNull();
  });

  it("rejects a genuine signature for a different serial", async () => {
    const other = await signPassSerial(LEGACY_KEY, "some-other-serial");
    expect(await verifyPassSerialSignature({ current: LEGACY_KEY }, LEGACY_MESSAGE, other)).toBeNull();
  });

  describe("during a rotation", () => {
    const keys = { current: ROTATED_KEY, previous: LEGACY_KEY };

    it("accepts a code signed with the new key", async () => {
      const signature = await signPassSerial(ROTATED_KEY, LEGACY_MESSAGE);
      expect(await verifyPassSerialSignature(keys, LEGACY_MESSAGE, signature)).toBe("current");
    });

    it("still accepts a code signed with the retired key, and says so", async () => {
      expect(await verifyPassSerialSignature(keys, LEGACY_MESSAGE, LEGACY_SIGNATURE)).toBe("previous");
    });

    it("rejects a signature from a key that was never ours", async () => {
      const forged = await signPassSerial("some-other-key".repeat(5), LEGACY_MESSAGE);
      expect(await verifyPassSerialSignature(keys, LEGACY_MESSAGE, forged)).toBeNull();
    });

    it("rejects the retired key's signature once the rotation ends", async () => {
      expect(
        await verifyPassSerialSignature({ current: ROTATED_KEY }, LEGACY_MESSAGE, LEGACY_SIGNATURE),
      ).toBeNull();
    });
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
