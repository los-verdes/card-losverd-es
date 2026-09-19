/**
 * "I bought my membership under a different address" (#144).
 *
 * The case this exists for: Apple's Hide My Email gives us a relay address
 * that matches no order, so a member in good standing is told they have no
 * membership. Apple's guidance is to treat the relay address as the account
 * identifier and never attempt to resolve it, so the fix cannot be to work
 * out who they are -- it has to be to let them tell us, and prove it.
 *
 * The proof is control of the address the membership was bought under: we
 * mail a link there, and following it while signed in sets `members.user_id`.
 * `requireActiveMembership` already matches on `user_id` as well as email, so
 * nothing downstream needs to know this happened.
 *
 * Anti-enumeration, as on `/email-card`: once the address is well-formed the
 * response is the same page whether or not it belongs to a member, and the
 * lookup runs inside `waitUntil` so neither the body nor its timing gives it
 * away. Signing in first narrows who can probe but doesn't remove the need --
 * an account is cheap.
 *
 * No Turnstile here, unlike `/email-card`: that form is open to the world,
 * this one is behind a login, and the rate limits below are what a signed-in
 * abuser actually runs into.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Session } from "../auth/session";
import { sendClaimLinkEmail } from "../email/claimLink";
import type { Env } from "../index";
import {
  consumeRateLimit,
  purgeExpiredRateLimits,
  type RateLimitRule,
} from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";
import { getMemberByEmail, isMembershipCurrent } from "./artifacts";
import { issueClaimToken, verifyClaimToken } from "./claimToken";
import { isWellFormedEmail } from "./email-card";
import { Page, SUPPORT_EMAIL } from "./layout";

export const CLAIM_PATH = "/claim-membership";

type ClaimEnv = { Bindings: Env; Variables: { session: Session } };

/** Per signed-in user, so one account can't sweep addresses. */
export const USER_RATE_LIMIT: RateLimitRule = {
  name: "claim-membership:user",
  limit: 5,
  windowSeconds: 60 * 60,
};

/**
 * Per address, so a member's inbox can't be flooded from several accounts.
 * Enforced silently inside `waitUntil`, keeping the response identical
 * whether or not the address belongs to anyone.
 */
export const RECIPIENT_RATE_LIMIT: RateLimitRule = {
  name: "claim-membership:recipient",
  limit: 3,
  windowSeconds: 24 * 60 * 60,
};

const ClaimForm: FC<{ error?: string }> = ({ error }) => (
  <Page title="Find My Membership">
    <h1>Find my membership</h1>
    <p>
      If you bought your membership under a different email address than the
      one you signed in with, enter it here. We'll email that address a link to
      confirm it's yours.
    </p>
    <p class="muted">
      This is what to use if you signed in with Apple and chose{" "}
      <strong>Hide My Email</strong>. Apple gives us a private relay address
      instead of your own, which won't match your order.
    </p>
    {error && (
      <p role="alert" style="color: var(--danger, #b00020)">
        {error}
      </p>
    )}
    <form method="post" action={CLAIM_PATH}>
      <p>
        <label for="email">Membership email address</label>
        <br />
        <input id="email" name="email" type="email" autocomplete="email" required />
      </p>
      <p>
        <button type="submit">Email me a confirmation link</button>
      </p>
    </form>
    <p>
      <a href="/no-active-membership">Back</a>
    </p>
  </Page>
);

const LinkSent: FC = () => (
  <Page title="Check Your Email">
    <h1>Check your email</h1>
    <p>
      If there's a current Los Verdes membership for that address, we've sent it
      a link to confirm it's yours. It should arrive within a few minutes.
    </p>
    <p class="muted">
      Open the link in this browser, while still signed in. It works for 30
      minutes.
    </p>
    <p>
      Nothing arrived? Check your spam folder and make sure you used the address
      your membership was purchased with, or contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
    <p>
      <a href={CLAIM_PATH}>Try another address</a>
    </p>
  </Page>
);

const ClaimFailed: FC<{ reason: string }> = ({ reason }) => (
  <Page title="Link Didn't Work">
    <h1>That link didn't work</h1>
    <p>{reason}</p>
    <p>
      <a href={CLAIM_PATH}>Try again</a>
    </p>
    <p>
      Still stuck? Contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
  </Page>
);

/**
 * Looks the address up and, only for a current member, mails a confirmation
 * link. Never throws: meant for `waitUntil`, with failures logged rather than
 * retried -- the member can ask again.
 *
 * "Current member" matches `/email-card` deliberately. A lapsed membership is
 * a different conversation, and linking one would still leave the member
 * looking at the no-membership page.
 */
export async function sendClaimLink(
  env: Env,
  email: string,
  userId: number,
): Promise<void> {
  try {
    await purgeExpiredRateLimits(env.DB, 2 * RECIPIENT_RATE_LIMIT.windowSeconds);
    const limit = await consumeRateLimit(
      env.DB,
      RECIPIENT_RATE_LIMIT,
      email.toLowerCase(),
    );
    if (!limit.allowed) {
      console.warn("Claim membership: recipient rate limit reached; not sending");
      return;
    }
    const member = await getMemberByEmail(env, email);
    if (!member || !isMembershipCurrent(member)) {
      return;
    }
    const token = await issueClaimToken(env.SESSION_SIGNING_KEY, {
      userId,
      memberId: member.member_id,
    });
    const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const url = `${base}${CLAIM_PATH}/confirm?token=${encodeURIComponent(token)}`;
    await sendClaimLinkEmail(env, member.email, url);
    console.log("Claim link sent", { memberId: member.member_id, userId });
  } catch (err) {
    console.error("Claim link delivery failed", { error: String(err) });
  }
}

const claim = new Hono<ClaimEnv>();

claim.get("/", requireAuth, (c) => c.html(<ClaimForm />));

claim.post("/", requireAuth, csrf(), async (c) => {
  const userId = c.get("session").userId;
  const limit = await consumeRateLimit(c.env.DB, USER_RATE_LIMIT, String(userId));
  if (!limit.allowed) {
    return c.html(
      <ClaimForm error="Too many attempts. Please wait a while before trying again." />,
      429,
    );
  }

  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? form.email.trim() : "";
  if (!isWellFormedEmail(email)) {
    return c.html(<ClaimForm error="That doesn't look like an email address." />, 400);
  }

  c.executionCtx.waitUntil(sendClaimLink(c.env, email, userId));
  return c.html(<LinkSent />);
});

claim.get("/confirm", requireAuth, async (c) => {
  const token = c.req.query("token") ?? "";
  const claimed = await verifyClaimToken(c.env.SESSION_SIGNING_KEY, token);
  if (!claimed) {
    return c.html(
      <ClaimFailed reason="It may have expired, or been used in a different browser. Links last 30 minutes." />,
      400,
    );
  }
  if (claimed.userId !== c.get("session").userId) {
    // The reason the token names the user at all. Without this check a
    // forwarded email would hand the membership to whoever opened it.
    console.warn("Claim membership: token presented by a different user", {
      tokenUserId: claimed.userId,
      sessionUserId: c.get("session").userId,
    });
    return c.html(
      <ClaimFailed reason="That link was meant for a different account. Sign in as the account you started from, then try again." />,
      403,
    );
  }

  // Only claims a membership that is unclaimed, or already this user's, so a
  // second person cannot take one over. Idempotent on purpose: following the
  // same link twice lands on the card rather than on an error.
  const linked = await c.env.DB.prepare(
    `UPDATE members SET user_id = ?
     WHERE member_id = ? AND (user_id IS NULL OR user_id = ?)`,
  )
    .bind(claimed.userId, claimed.memberId, claimed.userId)
    .run();
  if (!linked.meta.changes) {
    return c.html(
      <ClaimFailed reason="That membership is already linked to another account. Contact us and we'll sort it out." />,
      409,
    );
  }

  console.log("Membership claimed", {
    memberId: claimed.memberId,
    userId: claimed.userId,
  });
  return c.redirect("/?claimed=1");
});

export default claim;
