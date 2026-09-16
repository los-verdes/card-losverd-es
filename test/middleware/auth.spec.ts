import { describe, expect, it } from "vitest";
import { verifyPassAuthorization } from "../../src/middleware/auth";

describe("verifyPassAuthorization", () => {
  it("accepts a matching ApplePass token", () => {
    expect(verifyPassAuthorization("ApplePass secret-token", "secret-token")).toBe(
      true,
    );
  });

  it("rejects a mismatched token", () => {
    expect(verifyPassAuthorization("ApplePass wrong-token", "secret-token")).toBe(
      false,
    );
  });

  it("rejects a token of a different length without throwing (constant-time compare's length guard)", () => {
    expect(
      verifyPassAuthorization("ApplePass secret-tokenextra", "secret-token"),
    ).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    expect(verifyPassAuthorization(null, "secret-token")).toBe(false);
    expect(verifyPassAuthorization(undefined, "secret-token")).toBe(false);
  });

  it("rejects the wrong scheme (case-sensitive, unlike BigCommerce's webhook auth)", () => {
    expect(verifyPassAuthorization("Bearer secret-token", "secret-token")).toBe(
      false,
    );
    expect(verifyPassAuthorization("applepass secret-token", "secret-token")).toBe(
      false,
    );
  });
});
