/**
 * Email card delivery (the legacy app's `email_distribution_request`): a
 * no-login fallback where a member enters their email address and, if it
 * belongs to a current member, is emailed their card image and Apple Wallet
 * pass (plus a Google Wallet link when that's configured).
 *
 * Anti-enumeration (legacy los-verdes/digital-membership#2): once the
 * address is well-formed and the bot check passes, the response is the same
 * page whether or not the address belongs to a member. The member lookup
 * itself runs inside `waitUntil` along with the rest of the work, so neither
 * the response body nor its timing depends on it.
 *
 * No queue (migration plan Phase 2.5.1): a delivery failure is logged and not
 * retried; the member can simply submit the form again.
 *
 * Bot protection is Cloudflare Turnstile (src/email/turnstile.ts), replacing
 * the legacy app's reCAPTCHA.
 *
 * Rate limited per client IP and per recipient address (`IP_RATE_LIMIT`,
 * `RECIPIENT_RATE_LIMIT` below), without breaking the anti-enumeration
 * guarantee.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import { sendMembershipCardEmail } from "../email/card";
import {
  TURNSTILE_RESPONSE_FIELD,
  verifyTurnstileToken,
} from "../email/turnstile";
import type { Env } from "../index";
import {
  consumeRateLimit,
  purgeExpiredRateLimits,
  type RateLimitRule,
} from "../lib/rateLimit";
import { getMemberByEmail, isMembershipCurrent } from "./artifacts";
import { Page, SUPPORT_EMAIL } from "./layout";

// Deliberately loose: a plausible `local@domain.tld` shape. Whether the
// address is real is the mail service's (and the membership roll's) problem.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isWellFormedEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_SHAPE.test(email);
}

function isConfigured(env: Env): boolean {
  return Boolean(
    env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.EMAIL,
  );
}

const RequestForm: FC<{
  siteKey: string;
  email?: string;
  error?: string;
}> = ({ siteKey, email, error }) => (
  <Page title="Email My Card">
    <h1>Email my membership card</h1>
    <p>
      Enter the email address your membership was purchased with, and we'll
      email your membership card to it.
    </p>
    {error && (
      <p role="alert" style="color: var(--danger)">
        {error}
      </p>
    )}
    <form method="post" action="/email-card">
      <p>
        <label for="email">Email address</label>
        <br />
        <input
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          required
          value={email}
        />
      </p>
      <div class="cf-turnstile" data-sitekey={siteKey}></div>
      <p>
        <button type="submit">Email my card</button>
      </p>
    </form>
    <p>
      Prefer to sign in? <a href="/login">Log in</a> to see your card.
    </p>
    <p>
      <a href="/">Back to the start</a>
    </p>
    <script
      src="https://challenges.cloudflare.com/turnstile/v0/api.js"
      async
      defer
    ></script>
  </Page>
);

/**
 * Per client IP, counted on every POST before the bot check (so a flood can't
 * hammer Turnstile either). Exceeding it gets an explicit 429 -- that reveals
 * nothing about membership, since it's about the client, not the address.
 */
export const IP_RATE_LIMIT: RateLimitRule = {
  name: "email-card:ip",
  limit: 5,
  windowSeconds: 60 * 60,
};

/**
 * Per recipient address, so a member's inbox can't be flooded. Counted for
 * every well-formed, bot-checked submission -- member or not -- and enforced
 * silently inside `waitUntil`, keeping the response identical either way.
 */
export const RECIPIENT_RATE_LIMIT: RateLimitRule = {
  name: "email-card:recipient",
  limit: 3,
  windowSeconds: 24 * 60 * 60,
};

const TooManyRequests: FC = () => (
  <Page title="Email My Card">
    <h1>Too many requests</h1>
    <p>
      Please wait a while before trying again, or <a href="/login">log in</a> to
      see your card.
    </p>
  </Page>
);

const Unavailable: FC = () => (
  <Page title="Email My Card">
    <h1>Temporarily unavailable</h1>
    <p>
      Emailing membership cards is temporarily unavailable. Please try again
      later, or <a href="/login">log in</a> to see your card.
    </p>
  </Page>
);

const RequestReceived: FC = () => (
  <Page title="Email My Card">
    <h1>Check your email</h1>
    <p>
      If there's a current Los Verdes membership for that address, we've sent
      the membership card to it. It should arrive within a few minutes.
    </p>
    <p>
      Nothing arrived? Check your spam folder and make sure you used the address
      your membership was purchased with, or contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
    <p>
      <a href="/email-card">Send again</a>
    </p>
    <p>
      <a href="/">Back to the start</a>
    </p>
  </Page>
);

/**
 * Looks up `email` and, only for a current member, emails them their card.
 * Never throws: meant for `waitUntil`, with failures logged, not retried.
 */
export async function deliverCardByEmail(
  env: Env,
  email: string,
  submittedOn: string,
): Promise<void> {
  try {
    await purgeExpiredRateLimits(
      env.DB,
      2 * RECIPIENT_RATE_LIMIT.windowSeconds,
    );
    const recipientLimit = await consumeRateLimit(
      env.DB,
      RECIPIENT_RATE_LIMIT,
      email.toLowerCase(),
    );
    if (!recipientLimit.allowed) {
      console.warn("Email card: recipient rate limit reached; not sending");
      return;
    }
    const member = await getMemberByEmail(env, email);
    if (!member || !isMembershipCurrent(member)) {
      return;
    }
    // Non-null: isMembershipCurrent() requires an expiration date.
    const current = { ...member, expiration_date: member.expiration_date! };
    await sendMembershipCardEmail(env, current, { kind: "request", submittedOn });
    console.log("Email card sent", { memberId: member.member_id });
  } catch (err) {
    console.error("Email card delivery failed", { error: String(err) });
  }
}

const emailCard = new Hono<{ Bindings: Env }>();

emailCard.get("/", (c) => {
  if (!isConfigured(c.env)) {
    return c.html(<Unavailable />, 503);
  }
  return c.html(<RequestForm siteKey={c.env.TURNSTILE_SITE_KEY!} />);
});

emailCard.post("/", csrf(), async (c) => {
  if (!isConfigured(c.env)) {
    return c.html(<Unavailable />, 503);
  }
  const ipLimit = await consumeRateLimit(
    c.env.DB,
    IP_RATE_LIMIT,
    c.req.header("cf-connecting-ip") ?? "unknown",
  );
  if (!ipLimit.allowed) {
    c.header("Retry-After", String(ipLimit.retryAfterSeconds));
    return c.html(<TooManyRequests />, 429);
  }
  const siteKey = c.env.TURNSTILE_SITE_KEY!;
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? form.email.trim() : "";
  if (!isWellFormedEmail(email)) {
    return c.html(
      <RequestForm
        siteKey={siteKey}
        email={email}
        error="Please enter a valid email address."
      />,
      400,
    );
  }

  const token = form[TURNSTILE_RESPONSE_FIELD];
  const human = await verifyTurnstileToken(
    c.env.TURNSTILE_SECRET_KEY,
    typeof token === "string" ? token : undefined,
    c.req.header("cf-connecting-ip"),
  );
  if (!human) {
    return c.html(
      <RequestForm
        siteKey={siteKey}
        email={email}
        error="We couldn't verify that you're not a bot. Please try again."
      />,
      403,
    );
  }

  c.executionCtx.waitUntil(
    deliverCardByEmail(c.env, email, new Date().toISOString()),
  );
  return c.html(<RequestReceived />);
});

export default emailCard;
