/**
 * The member portal (the legacy app's `/`, `/no-active-membership-found`,
 * `/passes/google-pay`, and `/passes/apple-pay` routes): a logged-in member's
 * card page, plus the card image and wallet-pass downloads it links to.
 * Everything member-specific comes from src/member/artifacts.ts, so the
 * portal shows exactly what the PassKit web service and emailed cards do.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { every } from "hono/combine";
import { createMiddleware } from "hono/factory";
import type { FC } from "hono/jsx";
import type { Session } from "../auth/session";
import type { Env } from "../index";
import { AdminNav } from "../admin/nav";
import { recordOutcome } from "../lib/outcome";
import { formatMonthYear, formatShortDate } from "../lib/dateFormat";
import { fullOrderIdTitle, shortOrderId } from "../lib/orderIds";
import { CLAIM_PATH } from "./claimMembership";
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
  cardNameText,
  getApplePassBundle,
  getMemberByEmail,
  getMemberById,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "./artifacts";
import { CARD_WIDTH, CARD_HEIGHT } from "../cardimage/template";
import { appConfig } from "../bigcommerce/appJwt";
import { storeAccountFor } from "../bigcommerce/storeAccount";
import { STORE_DISCONNECT_PATH } from "../bigcommerce/storeHandoff";
import { Page, SUPPORT_EMAIL } from "./layout";
import {
  MAX_DISPLAY_NAME_LENGTH,
  clearDisplayName,
  getDisplayName,
  normalizeDisplayName,
  setDisplayName,
} from "./displayName";
import { CARD_THEMES, type CardTheme } from "../themes/cardTheme";
import { getThemeOptions, type ThemeOptions } from "../themes/eligibility";
import {
  ThemeNotAllowed,
  clearCardTheme,
  effectiveTheme,
  mayChooseTheme,
  setCardTheme,
} from "../themes/choice";

// The membership store the legacy no-membership page links to.
export const MEMBERSHIP_STORE_URL =
  "https://store.losverdesatx.org/membership/";

/**
 * The store's home page, for the card page's way back to it: this
 * environment's own storefront (the sandbox, on staging), or the store.
 * Members arrive from the store's "Membership card" link and may well have
 * shopping to finish.
 */
export function storeHomeUrl(env: Env): string {
  try {
    if (env.BIGCOMMERCE_STOREFRONT_URL) return new URL("/", env.BIGCOMMERCE_STOREFRONT_URL).toString();
  } catch {
    // A malformed setting falls back to the store below.
  }
  return new URL("/", MEMBERSHIP_STORE_URL).toString();
}

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
/** Every membership a user holds a claim to: under their address, and any linked to them. */
export async function findMembershipsForUser(env: Env, userId: number): Promise<(MemberRecord | null)[]> {
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
  return candidates;
}

export async function findCurrentMember(
  env: Env,
  userId: number,
): Promise<CurrentMember | null> {
  const candidates = await findMembershipsForUser(env, userId);
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
 * The way through to the admin pages, for the people who have them.
 *
 * This used to be one quiet line at the foot of the page, on the reasoning
 * that the page belongs to the member's own card and the admin tools are an
 * aside. In practice it was easy to miss entirely, and it named one
 * destination out of thirteen. An admin now gets the same nav here as on the
 * admin pages themselves, above the card rather than below it.
 *
 * It renders outside the card's narrow column (see `Page`), so the card looks
 * exactly as it does for everybody else.
 *
 * Shown on the no-membership page too: an admin who has never bought a
 * membership never reaches the card page at all, and would otherwise have to
 * know the URL.
 */
const adminNav = (isAdmin: boolean) => (isAdmin ? <AdminNav current="/" /> : null);

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
            <strong title={fullOrderIdTitle(displayOrderNumber(order.order_id))}>
              Order #{shortOrderId(displayOrderNumber(order.order_id))}
            </strong>
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

/**
 * Their store account (#38): connected or not, and the way to change that.
 * Shown only once this environment has a store app, so there is a handoff to
 * connect through.
 */
export interface StoreAccountView {
  connected: boolean;
  /** Where "Connect your store account" goes: the store's account page, which runs the handoff. */
  connectHref: string;
  /** What just happened, from the handoff's redirect. */
  notice?: "connected" | "taken" | "disconnected";
}

const STORE_NOTICES = {
  connected: { color: "var(--success)", text: "Your store account is connected." },
  disconnected: { color: "var(--success)", text: "Your store account is disconnected." },
  taken: {
    color: "var(--danger)",
    text: "That store account is already connected to someone else's card, so it wasn't connected to yours.",
  },
} as const;

const StoreAccount: FC<{ store: StoreAccountView }> = ({ store }) => (
  <section style="margin-top: 2rem">
    <h2 style="font-size: 1.1rem">Store account</h2>
    {store.notice && <p style={`color: ${STORE_NOTICES[store.notice].color}`}>{STORE_NOTICES[store.notice].text}</p>}
    {store.connected ? (
      <>
        <p class="muted">
          Connected. "Membership card" on the Los Verdes store brings you straight here, without signing in again.
        </p>
        <form method="post" action={STORE_DISCONNECT_PATH}>
          <button type="submit" class="quiet danger">
            Disconnect my store account
          </button>
        </form>
      </>
    ) : (
      <>
        <p class="muted">
          Connect the account you shop with, and "Membership card" on the store brings you straight here.
        </p>
        <a href={store.connectHref} class="action">
          Connect your store account
        </a>
      </>
    )}
  </section>
);

export const MemberCard: FC<{
  member: CurrentMember;
  orders: MemberOrder[];
  isAdmin: boolean;
  /** Whether they may choose a theme yet (`mayChooseTheme`): admins first, then everyone. */
  canChooseTheme?: boolean;
  /** Their store account, when this environment has a store app. */
  store?: StoreAccountView | null;
  /** The store's home page (`storeHomeUrl`). */
  storeUrl?: string;
}> = ({ member, orders, isAdmin, canChooseTheme = false, store = null, storeUrl }) => (
  <Page title="Membership Card" nav={adminNav(isAdmin)}>
    {storeUrl && (
      <p class="muted" style="margin: 0 0 0.5rem">
        <a href={storeUrl}>&larr; Back to the Los Verdes store</a>
      </p>
    )}
    <h1>Los Verdes Membership Card</h1>
    <p style="font-size: 1.5rem; margin-bottom: 0">
      {`${member.first_name} ${member.last_name}`.trim()}
    </p>
    {member.member_since && (
      <p>Member since {formatMonthYear(member.member_since)}</p>
    )}
    <p>Good through {formatShortDate(member.expiration_date)}</p>
    {/*
      Intrinsic dimensions, even though CSS sizes it. Without them the
      browser cannot know the shape until the bytes arrive, so it reserves
      no room and everything below jumps down when the card lands -- and
      this card is rendered on demand, so that arrival is never instant.
      With them the space is the right shape from the first paint and the
      image fades into it.
    */}
    <img
      class="card-image"
      src="/card.png"
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      // Sizing stays on the element rather than moving to the class.
      // /assets/app.css is cached for an hour, and this page is not, so for
      // up to an hour after a deploy a browser can hold HTML that needs a
      // rule its stylesheet has not got yet. A class carrying `width: 100%`
      // fails open at 1050px -- the card's intrinsic width -- which
      // overflows a phone screen. Inline, it cannot skew.
      style="width: 100%; height: auto"
      alt="Your Los Verdes membership card"
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
    <a href={NAME_PATH} class="action">
      Change the name on my card
    </a>
    {canChooseTheme && (
      <a href={THEME_PATH} class="action">
        Change how my card looks
      </a>
    )}
    {store && <StoreAccount store={store} />}
    <MembershipHistory orders={orders} email={member.email} />
    <LogoutButton />
  </Page>
);

/**
 * Apple's "Hide My Email" gives us a relay address instead of the member's
 * own, and Apple offers that choice on every sign-in. It is a perfectly
 * ordinary thing to pick, and it lands the member here: the relay address
 * matches no order, so they are told there is no membership while holding
 * one.
 *
 * Nothing we are given can join the two up, and Apple's guidance is not to
 * try -- the relay address is the account identifier, and the mailbox behind
 * it is never disclosed. So the member joins them up instead, by proving
 * control of the address they bought under (src/member/claimMembership.tsx).
 * Recognising the address is what lets this page offer that rather than the
 * generic advice to check the address on the order, which a relay address can
 * never satisfy.
 */

/**
 * Both domains Apple issues Sign in with Apple addresses on. New ones move
 * to `private.icloud.com` during 2026 while existing `privaterelay.appleid.com`
 * addresses keep working indefinitely, so this is a growing list rather than
 * a changing one -- Apple's own advice is to accept both.
 *
 * Matching only the older domain would not fail loudly. It would quietly
 * start treating new Apple members as ordinary strangers and telling them to
 * check the address on their order, which is the one thing that cannot help.
 */
export const APPLE_RELAY_DOMAINS = [
  "@privaterelay.appleid.com",
  "@private.icloud.com",
];

export function isAppleRelayAddress(email: string): boolean {
  const address = email.toLowerCase();
  return APPLE_RELAY_DOMAINS.some((domain) => address.endsWith(domain));
}

/**
 * Shown when somebody signs in and holds no current membership.
 *
 * The orders are the point of the page when there are any. Without them it
 * told a lapsed member to check they had used the right address -- advice
 * that is wrong whenever their orders are right here, and that sends them to
 * the merch team to be told what the page could have said itself. The history
 * marks each order that does not count, which is the actual answer to "I
 * bought one, where is it".
 *
 * With no orders at all the original wording stands: then a different address
 * genuinely is the likeliest explanation, and an empty history under a line
 * that already says nothing was found is just the same sentence twice.
 */
export const NoActiveMembership: FC<{
  email: string;
  isAdmin: boolean;
  orders: MemberOrder[];
}> = ({ email, isAdmin, orders }) => (
  <Page title="No Membership Found" nav={adminNav(isAdmin)}>
    <h1>No Active Membership Found</h1>
    <p>
      No current membership was found for <strong>{email}</strong>.
    </p>
    {orders.length > 0 ? (
      <p>
        We do have {orders.length === 1 ? "an order" : `${orders.length} orders`} on
        record under that address, but{" "}
        {orders.length === 1 ? "it is not current" : "none of them is current"}. The
        history below says what happened to each.
      </p>
    ) : isAppleRelayAddress(email) ? (
      <p>
        That is an Apple private relay address, which is what Apple sends us
        when you choose <strong>Hide My Email</strong>. It won't match the
        address on your order, even though your membership is fine. You don't
        need to sign in again -- tell us the address you bought your
        membership under and we'll confirm it by email.
      </p>
    ) : (
      <p>
        Check that the email address you signed in with matches the one used to
        purchase your membership. If you bought it under a different address,
        you can confirm that address by email instead of signing in again.
      </p>
    )}
    {orders.length > 0 && <MembershipHistory orders={orders} email={email} />}
    <a href={CLAIM_PATH} class="action">
      I bought my membership under a different address
    </a>
    <p>
      {orders.length > 0
        ? "Ready to renew? Grab a membership at the Los Verdes store."
        : "Not a member yet, but would like to be? Grab a membership at the Los Verdes store."}
    </p>
    <a href={MEMBERSHIP_STORE_URL} class="action">
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

/** The store account section, or null when this environment has no store app to connect through. */
async function storeAccountView(env: Env, userId: number, notice: string | undefined): Promise<StoreAccountView | null> {
  if (!appConfig(env) || !env.BIGCOMMERCE_STOREFRONT_URL) return null;
  const connectHref = new URL("/account.php", env.BIGCOMMERCE_STOREFRONT_URL);
  // A fragment, which survives the store's redirects where a query does not
  // (src/bigcommerce/storefront.ts).
  connectHref.hash = "lv-connect";
  return {
    connected: (await storeAccountFor(env, userId)) !== null,
    connectHref: connectHref.toString(),
    notice: notice === "connected" || notice === "taken" || notice === "disconnected" ? notice : undefined,
  };
}

portal.get("/", requireCurrentMember, async (c) => {
  const member = c.get("member");
  const [orders, isAdmin] = await Promise.all([
    getMemberOrderHistory(c.env, member.email),
    isCurrentAdmin(c.env, c.get("session").userId),
  ]);
  recordOutcome("card.viewed", { admin: isAdmin });
  return c.html(
    <MemberCard
      member={member}
      orders={orders}
      isAdmin={isAdmin}
      canChooseTheme={await mayChooseTheme(c.env, isAdmin)}
      store={await storeAccountView(c.env, c.get("session").userId, c.req.query("store"))}
      storeUrl={storeHomeUrl(c.env)}
    />,
  );
});


export const NAME_PATH = "/name";

const NameForm: FC<{
  member: CurrentMember;
  current: string | null;
  setByAdmin: boolean;
  error?: string;
  saved?: boolean;
}> = ({ member, current, setByAdmin, error, saved }) => (
  <Page title="The name on your card">
    <h1>The name on your card</h1>
    {saved && <p class="success">Saved. Any passes you have installed will catch up shortly.</p>}
    {error && <p class="danger">{error}</p>}
    <p>
      Your card currently says <strong>{cardNameText(member)}</strong>. You can
      put whatever you go by on it -- a nickname, a shorter version, however
      you spell it.
    </p>
    {setByAdmin && current && (
      <p class="muted">
        This was set for you by an admin. Changing it here replaces it.
      </p>
    )}
    <form method="post" action={NAME_PATH}>
      <label for="display_name">Name to show</label>
      <input
        id="display_name"
        name="display_name"
        type="text"
        value={current ?? ""}
        maxlength={MAX_DISPLAY_NAME_LENGTH}
        placeholder={`${member.first_name} ${member.last_name}`.trim()}
        autocomplete="off"
      />
      <button type="submit">Save</button>
    </form>
    {current && (
      <form method="post" action={NAME_PATH}>
        <input type="hidden" name="clear" value="1" />
        <button type="submit">
          Use the name from my orders instead
        </button>
      </form>
    )}
    <p>
      <a href="/">Back to your card</a>
    </p>
  </Page>
);

portal.get(NAME_PATH, requireCurrentMember, async (c) => {
  const member = c.get("member");
  const override = await getDisplayName(c.env, member.email);
  return c.html(
    <NameForm
      member={member}
      current={override?.display_name ?? null}
      setByAdmin={override?.source === "admin"}
      saved={c.req.query("saved") === "1"}
    />,
  );
});

portal.post(NAME_PATH, requireCurrentMember, csrf(), async (c) => {
  const member = c.get("member");
  const form = await c.req.formData();

  if (form.get("clear")) {
    await clearDisplayName(c.env, member.email, c.get("session").userId);
    recordOutcome("display_name.saved", { result: "cleared" });
    return c.redirect(`${NAME_PATH}?saved=1`, 303);
  }

  const result = normalizeDisplayName(String(form.get("display_name") ?? ""));
  if (!result.ok) {
    recordOutcome("display_name.saved", { result: "rejected" });
    const override = await getDisplayName(c.env, member.email);
    return c.html(
      <NameForm
        member={member}
        current={override?.display_name ?? null}
        setByAdmin={override?.source === "admin"}
        error={result.reason}
      />,
      400,
    );
  }

  await setDisplayName(c.env, member.email, result.value, "member", null, c.get("session").userId);
  recordOutcome("display_name.saved", { result: "set" });
  return c.redirect(`${NAME_PATH}?saved=1`, 303);
});

export const THEME_PATH = "/theme";

/**
 * Choosing how the card looks (#333): every theme the member may use, each
 * previewed as their own card, and a button to use it. The card page links
 * here only for somebody `mayChooseTheme()` allows -- admins first, while the
 * themes are tried out -- and anybody else is shown a 404.
 */
/**
 * The themes with the one the card is in now first, so the page opens on
 * what the member has rather than making them scroll to find it; the rest
 * keep their order (classic, then years).
 */
export function currentFirst(themes: readonly CardTheme[], current: CardTheme): CardTheme[] {
  return [...themes.filter((theme) => theme.id === current.id), ...themes.filter((theme) => theme.id !== current.id)];
}

const ThemeForm: FC<{
  options: ThemeOptions;
  current: CardTheme;
  chosen: boolean;
  error?: string;
  saved?: boolean;
}> = ({ options, current, chosen, error, saved }) => (
  <Page title="How your card looks">
    <h1>How your card looks</h1>
    {saved && (
      <p style="color: var(--success)">Saved. Any passes you have installed will catch up shortly.</p>
    )}
    {error && <p style="color: var(--danger)">{error}</p>}
    <p>
      Your card is drawn in <strong>{current.label}</strong>
      {chosen ? ", which you chose." : ", the default."} You can use the theme of
      any year you bought a membership, and of any subgroup you belong to, as
      well as the classic look.
    </p>
    {currentFirst(options.themes, current).map((theme) => (
      <form method="post" action={THEME_PATH} class="order">
        <input type="hidden" name="theme" value={theme.id} />
        <img
          class="card-image"
          src={`/card.png?theme=${encodeURIComponent(theme.id)}`}
          width={CARD_WIDTH}
          height={CARD_HEIGHT}
          // See MemberCard for why the size is on the element.
          style="width: 100%; height: auto"
          loading="lazy"
          alt={`Your card in the ${theme.label} theme`}
        />
        <p style="margin: 0.5rem 0">
          <strong>{theme.label}</strong>
          {theme === options.defaultTheme ? " (the default)" : ""}
        </p>
        {theme.id === current.id ? (
          <p class="muted">Your card looks like this now.</p>
        ) : (
          <button type="submit">Use this theme</button>
        )}
      </form>
    ))}
    {chosen && (
      <form method="post" action={THEME_PATH}>
        <input type="hidden" name="clear" value="1" />
        <button type="submit">Go back to the default ({options.defaultTheme.label})</button>
      </form>
    )}
    <p>
      <a href="/">Back to your card</a>
    </p>
  </Page>
);

/** Whether this visitor may choose a theme now; see `mayChooseTheme`. */
async function mayChoose(c: { env: Env; get(key: "session"): Session }): Promise<boolean> {
  return mayChooseTheme(c.env, await isCurrentAdmin(c.env, c.get("session").userId));
}

async function themePage(
  env: Env,
  member: CurrentMember,
  extra: { error?: string; saved?: boolean } = {},
) {
  const options = await getThemeOptions(env, member);
  return (
    <ThemeForm
      options={options}
      current={effectiveTheme(options, member.card_theme)}
      chosen={options.themes.some((theme) => theme.id === member.card_theme)}
      {...extra}
    />
  );
}

portal.get(THEME_PATH, requireCurrentMember, async (c) => {
  if (!(await mayChoose(c))) return c.notFound();
  return c.html(await themePage(c.env, c.get("member"), { saved: c.req.query("saved") === "1" }));
});

portal.post(THEME_PATH, requireCurrentMember, csrf(), async (c) => {
  if (!(await mayChoose(c))) return c.notFound();
  const member = c.get("member");
  const userId = c.get("session").userId;
  const form = await c.req.formData();

  if (form.get("clear")) {
    await clearCardTheme(c.env, member.email, "member", userId, CARD_THEMES, (work) => c.executionCtx.waitUntil(work));
    recordOutcome("card_theme.saved", { result: "cleared" });
    return c.redirect(`${THEME_PATH}?saved=1`, 303);
  }

  try {
    await setCardTheme(c.env, member, String(form.get("theme") ?? ""), "member", userId, CARD_THEMES, (work) =>
      c.executionCtx.waitUntil(work),
    );
  } catch (err) {
    if (!(err instanceof ThemeNotAllowed)) throw err;
    recordOutcome("card_theme.saved", { result: "rejected" });
    return c.html(await themePage(c.env, member, { error: "That theme isn't one your card can use." }), 400);
  }
  recordOutcome("card_theme.saved", { result: "set" });
  return c.redirect(`${THEME_PATH}?saved=1`, 303);
});

/**
 * The member's card, or with `?theme=` a preview of it in another theme they
 * may use, for the theme page. A preview is only for somebody who may choose
 * a theme now, and only of a theme they may use; anything else is a 404, so
 * the address cannot be used to see a theme that is not theirs.
 */
portal.get("/card.png", requireCurrentMember, async (c) => {
  const member = c.get("member");
  const themeId = c.req.query("theme");
  let theme: CardTheme | undefined;
  if (themeId !== undefined) {
    const allowed = await mayChooseTheme(c.env, await isCurrentAdmin(c.env, c.get("session").userId));
    theme = allowed
      ? (await getThemeOptions(c.env, member)).themes.find((option) => option.id === themeId)
      : undefined;
    if (!theme) return c.text("No such theme for this card.", 404);
  }
  const png = await renderCardImage(c.env, member, theme);
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
  recordOutcome("pass.downloaded", { wallet: "apple" });
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
    recordOutcome("pass.downloaded", { wallet: "google", result: "unavailable" });
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
  recordOutcome("pass.downloaded", { wallet: "google", result: "ok" });
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
  // Keyed on the address they signed in with, which is the same column a
  // membership would have been derived from -- so if anything is here, it is
  // the explanation for why nothing was.
  const orders = await getMemberOrderHistory(c.env, user.email);
  // The page most likely to hold the surprises: signed in, no card. Whether
  // they have orders under this address, and whether it is an Apple relay
  // address (whose orders would be under another), are the two things that
  // say which kind of surprise it is.
  recordOutcome("membership.none", {
    has_orders: orders.length > 0,
    counting_orders: orders.filter((order) => order.counts).length,
    apple_relay: isAppleRelayAddress(user.email),
  });
  return c.html(
    <NoActiveMembership
      email={user.email}
      isAdmin={user.is_admin === 1}
      orders={orders}
    />,
  );
});

export default portal;
