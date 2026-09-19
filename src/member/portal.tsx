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
  displayOrderNumber,
  getMemberOrderHistory,
  type MemberOrder,
} from "./orderHistory";
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
import { Page, SUPPORT_EMAIL } from "./layout";

// The membership store the legacy no-membership page links to.
export const MEMBERSHIP_STORE_URL =
  "https://store.losverdesatx.org/membership/";

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

/** Where the admin pages start; their own nav links the rest. */
export const ADMIN_HOME = "/admin/reports";

/**
 * Whether this user is an admin, read from D1 rather than taken from the
 * session cookie's `isAdmin` claim.
 *
 * The claim is only refreshed on sliding renewal, which can be thirty days
 * apart, so trusting it would leave someone just granted admin with no way in
 * for a month, and someone just demoted following a link to a 403.
 * `requireAdmin` reads D1 for the same reason; this keeps the link and the
 * door in agreement.
 */
export async function isCurrentAdmin(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?")
    .bind(userId)
    .first<{ is_admin: number }>();
  return row?.is_admin === 1;
}

/**
 * A way through to the admin pages for the people who have them, kept
 * deliberately quiet: a plain line rather than another bordered action, since
 * this page belongs to the member's own card and the admin tools are an
 * aside. Shown on the no-membership page too -- an admin who has never bought
 * a membership never reaches the card page at all, and would otherwise have
 * to know the URL.
 */
const AdminLink: FC = () => (
  <p class="admin-link">
    <a href={ADMIN_HOME}>Admin: membership reports and orders</a>
  </p>
);

/**
 * Every order on record for this member, counting or not. An order that does
 * not count says so: a refunded or cancelled one is the usual explanation for
 * a membership that has expired, and leaving it out would make the card's
 * dates look arbitrary.
 */
export const MembershipHistory: FC<{ orders: MemberOrder[]; email: string }> = ({
  orders,
  email,
}) => (
  <section style="margin-top: 2rem">
    <h2 style="font-size: 1.1rem">Membership history</h2>
    {orders.length === 0 ? (
      <p class="muted">
        No membership orders are on record for <strong>{email}</strong>.
      </p>
    ) : (
      orders.map((order) => (
        <div class="order">
          <p style="margin: 0">
            <strong>Order #{displayOrderNumber(order.order_id)}</strong>
            {order.product_name ? ` — ${order.product_name}` : ""}
          </p>
          <p class="muted">
            {formatShortDate(order.created_on.slice(0, 10))} to{" "}
            {formatShortDate(order.expires_on.slice(0, 10))}
            {order.status ? ` · ${order.status}` : ""}
          </p>
          {!order.counts && (
            <p class="muted">
              This order doesn't count towards membership.
            </p>
          )}
        </div>
      ))
    )}
  </section>
);

export const MemberCard: FC<{
  member: CurrentMember;
  orders: MemberOrder[];
  isAdmin: boolean;
}> = ({ member, orders, isAdmin }) => (
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
    <a href="/passes/apple.pkpass" class="action">
      Add to Apple Wallet
    </a>
    <a href="/passes/google" class="action">
      Add to Google Wallet
    </a>
    <a href="/email-card" class="action">
      Email me my card
    </a>
    <MembershipHistory orders={orders} email={member.email} />
    {isAdmin && <AdminLink />}
    <LogoutButton />
  </Page>
);

/**
 * Apple's "Hide My Email" gives us a relay address instead of the member's
 * own, and Apple offers that choice on every sign-in. It is a perfectly
 * ordinary thing to pick, and it lands the member here: the relay address
 * matches no order, so they are told there is no membership while holding
 * one. Nothing can join the two up -- the relay address is all Apple gives
 * us -- so the least we can do is say which of the two problems this is,
 * rather than leaving someone to conclude their membership has vanished.
 */
export const APPLE_RELAY_DOMAIN = "@privaterelay.appleid.com";

export function isAppleRelayAddress(email: string): boolean {
  return email.toLowerCase().endsWith(APPLE_RELAY_DOMAIN);
}

export const NoActiveMembership: FC<{ email: string; isAdmin: boolean }> = ({
  email,
  isAdmin,
}) => (
  <Page title="No Membership Found">
    <h1>No Active Membership Found</h1>
    <p>
      No current membership was found for <strong>{email}</strong>.
    </p>
    {isAppleRelayAddress(email) ? (
      <p>
        That is an Apple private relay address, which is what Apple sends us
        when you choose <strong>Hide My Email</strong>. It won't match the
        address on your order, even though your membership is fine. Log out
        and sign in again, either with Apple choosing{" "}
        <strong>Share My Email</strong>, or with the account you used to buy
        your membership.
      </p>
    ) : (
      <p>
        Check that the email address you signed in with matches the one used to
        purchase your membership. If it doesn't, log out and sign back in with
        that account.
      </p>
    )}
    <p>
      Not a member yet, but would like to be? Grab a membership at the Los
      Verdes store.
    </p>
    <a href={MEMBERSHIP_STORE_URL} class="action">
      Visit Membership Store
    </a>
    <p>
      Otherwise, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
      for help.
    </p>
    {isAdmin && <AdminLink />}
    <LogoutButton />
  </Page>
);

const portal = new Hono<PortalEnv>();

portal.get("/", requireCurrentMember, async (c) => {
  const member = c.get("member");
  const [orders, isAdmin] = await Promise.all([
    getMemberOrderHistory(c.env, member.email),
    isCurrentAdmin(c.env, c.get("session").userId),
  ]);
  return c.html(<MemberCard member={member} orders={orders} isAdmin={isAdmin} />);
});

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
        <a href="/" class="action">
          Back to my card
        </a>
      </Page>,
      503,
    );
  }
  return c.redirect(saveUrl);
});

portal.get(NO_ACTIVE_MEMBERSHIP_PATH, requireAuth, async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT email, is_admin FROM users WHERE id = ?",
  )
    .bind(c.get("session").userId)
    .first<{ email: string; is_admin: number }>();
  if (!user) {
    return c.redirect(LOGIN_PATH);
  }
  return c.html(
    <NoActiveMembership email={user.email} isAdmin={user.is_admin === 1} />,
  );
});

export default portal;
