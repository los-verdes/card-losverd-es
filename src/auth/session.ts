/**
 * Stateless signed session cookie (the migration plan's Phase 2.3.1).
 *
 * The session is an HS256 JWT signed with `SESSION_SIGNING_KEY` -- a fresh
 * secret, deliberately *not* the legacy app's `SECRET_KEY` (see Phase
 * 2.3.1 for why that key's two jobs are being split). No D1 session table:
 * logout clears the cookie, and a session can't be force-expired early.
 * That tradeoff is accepted in exchange for zero session-store reads on
 * the hot path.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "lv_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Session {
  userId: number;
  isAdmin: boolean;
  /** Unix epoch seconds. */
  issuedAt: number;
  /** Unix epoch seconds. */
  expiresAt: number;
}

function signingKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error("SESSION_SIGNING_KEY is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function issueSessionToken(
  secret: string,
  user: { userId: number; isAdmin: boolean },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new SignJWT({ adm: user.isAdmin })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.userId))
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + SESSION_TTL_SECONDS)
    .sign(signingKey(secret));
}

/**
 * Returns the decoded session, or `null` for anything that isn't a valid,
 * unexpired session signed with `secret` (tampered, expired, wrong alg,
 * malformed). Never throws for bad *input* -- only for missing config.
 */
export async function verifySessionToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  const key = signingKey(secret);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      currentDate: new Date(nowSeconds * 1000),
    });
    const userId = Number(payload.sub);
    if (
      !Number.isSafeInteger(userId) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      userId,
      isAdmin: payload.adm === true,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Sliding expiry: reissue once a session is past the halfway point of its
 * lifetime, so active users never hit a surprise logout.
 */
export function shouldRenewSession(
  session: Session,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return nowSeconds - session.issuedAt > SESSION_TTL_SECONDS / 2;
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    // Lax: no flow needs this cookie on cross-site requests. (The legacy app
    // used None for a BigCommerce storefront login handoff, since dropped.
    // Apple's cross-site sign-in callback relies on Auth.js's own cookies.)
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
}
