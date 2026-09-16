import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  issueSessionToken,
  shouldRenewSession,
  verifySessionToken,
} from "../../src/auth/session";

const SECRET = "test-session-signing-key-0123456789";
const NOW = 1_800_000_000; // fixed epoch seconds

describe("issueSessionToken / verifySessionToken", () => {
  it("round-trips userId and isAdmin with a 30-day expiry", async () => {
    const token = await issueSessionToken(SECRET, { userId: 42, isAdmin: true }, NOW);
    expect(await verifySessionToken(SECRET, token, NOW)).toEqual({
      userId: 42,
      isAdmin: true,
      issuedAt: NOW,
      expiresAt: NOW + SESSION_TTL_SECONDS,
    });
  });

  it("rejects a token signed with a different key", async () => {
    const token = await issueSessionToken("some-other-signing-key-abcdefgh", { userId: 1, isAdmin: false }, NOW);
    expect(await verifySessionToken(SECRET, token, NOW)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await issueSessionToken(SECRET, { userId: 1, isAdmin: false }, NOW);
    const [header, , signature] = token.split(".");
    const forgedPayload = btoa(JSON.stringify({ sub: "1", adm: true, iat: NOW, exp: NOW + 60 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifySessionToken(SECRET, `${header}.${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const token = await issueSessionToken(SECRET, { userId: 1, isAdmin: false }, NOW);
    expect(await verifySessionToken(SECRET, token, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    expect(await verifySessionToken(SECRET, "not-a-jwt", NOW)).toBeNull();
  });

  it("rejects a validly-signed token with a non-integer subject or missing iat", async () => {
    const key = new TextEncoder().encode(SECRET);
    const badSub = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("not-a-number")
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 60)
      .sign(key);
    expect(await verifySessionToken(SECRET, badSub, NOW)).toBeNull();

    const noIat = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setExpirationTime(NOW + 60)
      .sign(key);
    expect(await verifySessionToken(SECRET, noIat, NOW)).toBeNull();

    const noExp = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setIssuedAt(NOW)
      .sign(key);
    expect(await verifySessionToken(SECRET, noExp, NOW)).toBeNull();
  });

  it("only treats adm === true as admin", async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ adm: "true" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 60)
      .sign(key);
    expect((await verifySessionToken(SECRET, token, NOW))?.isAdmin).toBe(false);
  });

  it("fails closed when the signing key isn't configured", async () => {
    await expect(issueSessionToken("", { userId: 1, isAdmin: false }, NOW)).rejects.toThrow(
      /SESSION_SIGNING_KEY/,
    );
    await expect(verifySessionToken("", "x.y.z", NOW)).rejects.toThrow(/SESSION_SIGNING_KEY/);
  });

  it("defaults to the current time", async () => {
    const token = await issueSessionToken(SECRET, { userId: 7, isAdmin: false });
    const session = await verifySessionToken(SECRET, token);
    expect(session?.userId).toBe(7);
    expect(shouldRenewSession(session!)).toBe(false);
  });
});

describe("shouldRenewSession", () => {
  const session = { userId: 1, isAdmin: false, issuedAt: NOW, expiresAt: NOW + SESSION_TTL_SECONDS };

  it("does not renew before the halfway point", () => {
    expect(shouldRenewSession(session, NOW + SESSION_TTL_SECONDS / 2)).toBe(false);
  });

  it("renews past the halfway point", () => {
    expect(shouldRenewSession(session, NOW + SESSION_TTL_SECONDS / 2 + 1)).toBe(true);
  });
});
