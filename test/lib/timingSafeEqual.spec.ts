import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../../src/lib/timingSafeEqual";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for a mismatch of the same length", () => {
    expect(timingSafeEqual("secret-tokenA", "secret-tokenB")).toBe(false);
  });

  it("returns false for strings of different lengths, without throwing", () => {
    expect(timingSafeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
