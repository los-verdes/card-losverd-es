/**
 * The token in a "claim your membership" email (#144).
 *
 * Apple's Hide My Email hands us a relay address that matches no order, and
 * Apple's own guidance is to treat that address as the account identifier
 * rather than try to resolve it -- there is no supported way back to the real
 * mailbox. So the member keeps signing in as the relay address and separately
 * proves control of the address their membership was bought under. This token
 * is that proof, carried in a link mailed to the address on file.
 *
 * Two properties make it safe, and the second is the one that is easy to
 * leave out:
 *
 *   - It names the member *and* the user who asked. A token carrying only the
 *     member would link whoever opened it, which turns a forwarded email into
 *     a takeover of that membership.
 *   - Following the link still requires being signed in as that user. The
 *     token alone is not a credential; it is the second half of one.
 *
 * Deliberately stateless -- no table of issued tokens, nothing to expire or
 * sweep. Single use would buy very little here: replaying a token re-links the
 * same member to the same user, and anyone able to replay it already holds
 * that user's session, at which point they are that user.
 */

import { SignJWT, jwtVerify } from "jose";

/**
 * Half an hour. Long enough for mail to arrive and be read, short enough that
 * a link left sitting in an inbox stops working.
 */
export const CLAIM_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * The `sub` of every claim token, and the reason one cannot be used as a
 * session cookie. `verifySessionToken` reads `sub` as a user id, and
 * `Number("membership-claim")` is NaN, so it rejects these before looking at
 * anything else. Session tokens fail here in turn: their `sub` is a number and
 * they carry no member. The two are signed with the same key, so this
 * separation is what keeps them from being interchangeable.
 */
const CLAIM_SUBJECT = "membership-claim";

export interface ClaimTokenPayload {
  /** `users.id` that requested the claim. */
  userId: number;
  /** `members.member_id` being claimed. */
  memberId: string;
}

function signingKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error("SESSION_SIGNING_KEY is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function issueClaimToken(
  secret: string,
  claim: ClaimTokenPayload,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new SignJWT({ uid: claim.userId, mid: claim.memberId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(CLAIM_SUBJECT)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + CLAIM_TOKEN_TTL_SECONDS)
    .sign(signingKey(secret));
}

/**
 * The claim, or `null` for anything that isn't a valid, unexpired claim token
 * signed with `secret`. Never throws for bad input -- only for missing config.
 */
export async function verifyClaimToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ClaimTokenPayload | null> {
  // Outside the `try` on purpose, matching `verifySessionToken`: an unset
  // signing key is a deployment fault, not a bad link, and swallowing it
  // would tell every member their link had expired while the real cause sat
  // in the configuration.
  const key = signingKey(secret);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      subject: CLAIM_SUBJECT,
      currentDate: new Date(nowSeconds * 1000),
    });
    const userId = payload.uid;
    const memberId = payload.mid;
    if (
      typeof userId !== "number" ||
      !Number.isSafeInteger(userId) ||
      typeof memberId !== "string" ||
      memberId === ""
    ) {
      return null;
    }
    return { userId, memberId };
  } catch {
    return null;
  }
}
