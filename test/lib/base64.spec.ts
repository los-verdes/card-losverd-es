import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/lib/base64";

describe("bytesToBase64", () => {
  it("encodes a Uint8Array with padding", () => {
    expect(bytesToBase64(new TextEncoder().encode("hi"))).toBe("aGk=");
  });

  it("encodes an ArrayBuffer", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello").buffer)).toBe(
      "aGVsbG8=",
    );
  });

  it("encodes empty input as an empty string", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("round-trips input larger than one chunk", () => {
    const bytes = new Uint8Array(20_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (ch) =>
      ch.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });

  it("respects a Uint8Array view's offset and length", () => {
    const backing = new TextEncoder().encode("xxhixx");
    expect(bytesToBase64(backing.subarray(2, 4))).toBe("aGk=");
  });
});
