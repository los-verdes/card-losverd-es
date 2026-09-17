/**
 * The member portal (the legacy app's `/`, `/no-active-membership-found`,
 * `/passes/google-pay`, and `/passes/apple-pay` routes): a logged-in member's
 * card page, plus the card image and wallet-pass downloads it links to.
 * Everything member-specific comes from src/member/artifacts.ts, so the
 * portal shows exactly what the PassKit web service and emailed cards do.
 */

import { Hono } from "hono";
import { every } from "hono/combine";
import { createMiddleware } from "hono/factory";
import type { FC } from "hono/jsx";
import type { Session } from "../auth/session";
import type { Env } from "../index";
import { formatMonthYear, formatShortDate } from "../lib/dateFormat";
import {
  LOGIN_PATH,
  NO_ACTIVE_MEMBERSHIP_PATH,
  requireActiveMembership,
  requireAuth,
} from "../middleware/auth";
import {
  buildGoogleWalletSaveUrl,
  getApplePassBundle,
  getMemberByEmail,
  getMemberById,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "./artifacts";
import { Page } from "./layout";

// The membership store the legacy no-membership page links to.
export const MEMBERSHIP_STORE_URL =
  "https://store.losverdesatx.org/membership/";
const SUPPORT_EMAIL = "merchteam@losverdesatx.org";

type CurrentMember = MemberRecord & { expiration_date: string };

export type PortalEnv = {
  Bindings: Env;
  Variables: { session: Session; member: CurrentMember };
};

/**
 * The logged-in user's current membership: the member row matching their
 * email, else one linked to them by `members.user_id` (the same two ways
 * `requireActiveMembership` matches), preferring whichever is current.
 */
async function findCurrentMember(
  env: Env,
  userId: number,
): Promise<CurrentMember | null> {
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  const candidates = [user ? await getMemberByEmail(env, user.email) : null];
  const { results: linked } = await env.DB.prepare(
    "SELECT member_id FROM members WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ member_id: string }>();
  for (const { member_id } of linked) {
    candidates.push(await getMemberById(env, member_id));
  }
  return (
    candidates.find(
      (member): member is CurrentMember =>
        member !== null && isMembershipCurrent(member),
    ) ?? null
  );
}

/**
 * Sets `c.get("member")` to the session user's current membership. Runs
 * after `requireActiveMembership`, so a miss only happens if the membership
 * lapsed or was unlinked in between; it's handled the same way.
 */
export const loadCurrentMember = createMiddleware<PortalEnv>(
  async (c, next) => {
    const member = await findCurrentMember(c.env, c.get("session").userId);
    if (!member) {
      return c.redirect(NO_ACTIVE_MEMBERSHIP_PATH);
    }
    c.set("member", member);
    await next();
  },
);

const requireCurrentMember = every(requireActiveMembership, loadCurrentMember);

const LogoutButton: FC = () => (
  <form method="post" action="/logout" style="margin-top: 2rem">
    <button type="submit">Log out</button>
  </form>
);

const linkStyle =
  "display: block; margin: 0.75rem 0; padding: 0.75rem; border: 1px solid #00B140; border-radius: 0.5rem; color: inherit; text-decoration: none";

export const MemberCard: FC<{ member: CurrentMember }> = ({ member }) => (
  <Page title="Membership Card">
    <h1>Los Verdes Membership Card</h1>
    <p style="font-size: 1.5rem; margin-bottom: 0">
      {`${member.first_name} ${member.last_name}`.trim()}
    </p>
    <p style="margin-top: 0.25rem">{member.membership_tier}</p>
    {member.member_since && (
      <p>Member since {formatMonthYear(member.member_since)}</p>
    )}
    <p>Good through {formatShortDate(member.expiration_date)}</p>
    <img
      src="/card.png"
      alt="Your Los Verdes membership card"
      style="width: 100%; height: auto"
    />
    <a href="/passes/apple.pkpass" style={linkStyle}>
      Add to Apple Wallet
    </a>
    <a href="/passes/google" style={linkStyle}>
      Add to Google Wallet
    </a>
    <a href="/email-card" style={linkStyle}>
      Email me my card
    </a>
    <LogoutButton />
  </Page>
);

export const NoActiveMembership: FC<{ email: string }> = ({ email }) => (
  <Page title="No Membership Found">
    <h1>No Active Membership Found</h1>
    <p>
      No current membership was found for <strong>{email}</strong>.
    </p>
    <p>
      Check that the email address you signed in with matches the one used to
      purchase your membership. If it doesn't, log out and sign back in with
      that account.
    </p>
    <p>
      Not a member yet, but would like to be? Grab a membership at the Los
      Verdes store.
    </p>
    <a href={MEMBERSHIP_STORE_URL} style={linkStyle}>
      Visit Membership Store
    </a>
    <p>
      Otherwise, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
      for help.
    </p>
    <LogoutButton />
  </Page>
);

const portal = new Hono<PortalEnv>();

portal.get("/", requireCurrentMember, (c) =>
  c.html(<MemberCard member={c.get("member")} />),
);

portal.get("/card.png", requireCurrentMember, async (c) => {
  const png = await renderCardImage(c.env, c.get("member"));
  // See sha1Hex in src/passkit/generator.ts for why this narrowing is needed.
  return new Response(png as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
    },
  });
});

portal.get("/passes/apple.pkpass", requireCurrentMember, async (c) => {
  const bundle = await getApplePassBundle(c.env, c.get("member"));
  return new Response(bundle as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition":
        'attachment; filename="los-verdes-membership.pkpass"',
    },
  });
});

portal.get("/passes/google", requireCurrentMember, async (c) => {
  let saveUrl: string;
  try {
    saveUrl = await buildGoogleWalletSaveUrl(c.env, c.get("member"));
  } catch (err) {
    console.error("Google Wallet save link unavailable:", err);
    return c.html(
      <Page title="Google Wallet Unavailable">
        <h1>Google Wallet is unavailable</h1>
        <p>
          Adding your card to Google Wallet isn't available right now. Please
          try again later, or use one of the other options on your card page.
        </p>
        <a href="/" style={linkStyle}>
          Back to my card
        </a>
      </Page>,
      503,
    );
  }
  return c.redirect(saveUrl);
});

portal.get(NO_ACTIVE_MEMBERSHIP_PATH, requireAuth, async (c) => {
  const user = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(c.get("session").userId)
    .first<{ email: string }>();
  if (!user) {
    return c.redirect(LOGIN_PATH);
  }
  return c.html(<NoActiveMembership email={user.email} />);
});

export default portal;
