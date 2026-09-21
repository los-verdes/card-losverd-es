/**
 * The token in a card email's unsubscribe link.
 *
 * Anyone can ask for a card to be emailed to any member's address
 * (/email-card), so the recipient needs a way to make that stop that doesn't
 * depend on who is asking. The token proves only that its holder received
 * mail at the address it names -- which is exactly who should decide.
 *
 * It never expires. An unsubscribe link has to work from an email that has
 * sat in an inbox for a year, and the worst a leaked one can do is stop or
 * restart card emails to the one address it was sent to.
 *
 * Signed with `SESSION_SIGNING_KEY`, like claim links (src/member/claimToken.ts);
 * the `sub` keeps the three from being interchangeable. A session reads `sub`
 * as a user id, a claim token requires `membership-claim`, and this requires
 * its own, so none of them verifies as either of the others.
 */

import { SignJWT, jwtVerify } from "jose";

const UNSUBSCRIBE_SUBJECT = "email-unsubscribe";

export const UNSUBSCRIBE_PATH = "/email/unsubscribe";

function signingKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error("SESSION_SIGNING_KEY is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function issueUnsubscribeToken(secret: string, email: string): Promise<string> {
  return new SignJWT({ em: email.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(UNSUBSCRIBE_SUBJECT)
    .sign(signingKey(secret));
}

/**
 * The address, or `null` for anything that isn't a valid unsubscribe token
 * signed with `secret`. Throws only for missing config, like the others.
 */
export async function verifyUnsubscribeToken(secret: string, token: string): Promise<string | null> {
  const key = signingKey(secret);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      subject: UNSUBSCRIBE_SUBJECT,
    });
    return typeof payload.em === "string" && payload.em.includes("@") ? payload.em : null;
  } catch {
    return null;
  }
}

/** The link for `email`, on the site's public origin. */
export async function unsubscribeUrl(
  env: { PUBLIC_BASE_URL: string; SESSION_SIGNING_KEY: string },
  email: string,
): Promise<string> {
  const token = await issueUnsubscribeToken(env.SESSION_SIGNING_KEY, email);
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
}
