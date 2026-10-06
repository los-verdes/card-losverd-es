/**
 * Finding a member from whatever they happened to quote (#190).
 *
 * Every pass this system issues prints a **Card #** on its back -- the
 * member's `member_id` -- and until this existed nothing could look one up.
 * Every admin lookup was keyed on email, which is the one thing a member
 * writing in often does not know: which address their membership is under is
 * frequently the actual problem they are writing about. They can always read
 * the back of their own pass.
 *
 * So this accepts any of the three identifiers a person might have to hand --
 * a card number, an email address, or an order number -- rather than making
 * the Merch Team work out which door to use.
 *
 * A second form finds people by part of a name or a Slack handle (#320), for
 * when all anybody has is who somebody is. It is a separate form rather than
 * a fourth shape of the first because the first treats anything unrecognised
 * as an order number, and because a name matches many people where the other
 * three match one.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";
import { isWellFormedEmail } from "../member/email-card";
import {
  cardNameText,
  findMembersByName,
  getMemberById,
  getMemberByEmail,
  renderCardImage,
  type MemberRecord,
  type NameMatch,
} from "../member/artifacts";
import { CARD_HEIGHT, CARD_WIDTH } from "../cardimage/template";
import { getMemberOrderHistory, type MemberOrder } from "../member/orderHistory";
import {
  MAX_DISPLAY_NAME_LENGTH,
  clearDisplayName,
  getDisplayName,
  normalizeDisplayName,
  setDisplayName,
} from "../member/displayName";
import {
  MAX_REVOCATION_NOTE_LENGTH,
  restoreCard,
  revokeCard,
} from "../member/revocation";
import { MAX_EXPULSION_NOTE_LENGTH, expelPerson, isExpelled, readmitPerson } from "../member/expulsion";
import { readWholeAuditLog, type AuditEntry } from "../audit/log";
import { unlinkStoreAccount } from "../bigcommerce/storeAccount";
import { CARD_THEMES, type CardTheme } from "../themes/cardTheme";
import { CARD_GROUPS } from "../themes/groups";
import { getThemeOptions, type ThemeOptions } from "../themes/eligibility";
import {
  ThemeNotAllowed,
  clearCardTheme,
  effectiveTheme,
  getCardThemeChoice,
  mayChooseTheme,
  setCardTheme,
  type ThemeChoice,
} from "../themes/choice";
import { emailFootprint, type EmailFootprint } from "./attribution";
import { AuditHistory } from "./audit";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";
import { StoreCustomerLink, StoreOrderLink } from "./storeLinks";
import { dayText } from "./when";
import {
  MemberSinceSection,
  clearMemberSince,
  lookupMemberSince,
  parseMemberSince,
  saveMemberSince,
  type MemberSinceSubject,
} from "./memberSince";
import { OrderLink, RereadButton, orderPath, rereadMessage } from "./orders";
import { moveOrdersPath } from "./moveOrders";
import { renewalState, renewalText, renewalsForMember, type RenewalRow } from "../minibc/renewals";

const members = new Hono<AuthEnv & { Bindings: Env }>();
members.use("*", requireAdmin);
// `no-store`, like every other admin page: this one shows a member's name,
// address, card number and order history in one place.
members.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

export const MEMBERS_PATH = "/admin/members";

/** A card number as printed on the back of a pass. */
const CARD_NUMBER = /^LV-[0-9a-f-]{8,}$/i;

export type Lookup =
  | { kind: "empty" }
  | { kind: "email"; value: string }
  | { kind: "card"; value: string }
  | { kind: "order"; value: string };

/**
 * What the admin typed, by shape.
 *
 * Deliberately permissive about order numbers: anything that is neither an
 * email nor a card number is tried as one, because order ids come in several
 * shapes (`1001` from the store, a 24-character hex id from the
 * Squarespace era) and guessing wrong costs a "not found" rather than
 * anything worse.
 */
export function classify(raw: string): Lookup {
  const value = raw.trim();
  if (value === "") return { kind: "empty" };
  if (value.includes("@")) return { kind: "email", value: value.toLowerCase() };
  if (CARD_NUMBER.test(value)) return { kind: "card", value };
  return { kind: "order", value };
}

const SearchForm: FC<{ q: string }> = ({ q }) => (
  <form method="get" action={MEMBERS_PATH}>
    <label for="q">Card number, email address, or order number</label>
    <input id="q" name="q" type="text" value={q} autocomplete="off" placeholder="LV-..." />
    <button type="submit">Find</button>
  </form>
);

/** Fewer letters than this would list a good share of the membership. */
export const MIN_NAME_SEARCH_LENGTH = 2;

/** Enough to scan by eye; past it, more letters are the better answer. */
export const NAME_SEARCH_LIMIT = 50;

export type NameSearch =
  | { kind: "empty" }
  | { kind: "too-short" }
  | { kind: "name"; value: string }
  | { kind: "slack-handle"; value: string };

/**
 * What was typed into the name form. A leading `@` means a Slack handle,
 * the way Slack itself writes one; the email form is where an address goes.
 */
export function parseNameSearch(raw: string): NameSearch {
  const value = raw.trim();
  if (value === "") return { kind: "empty" };
  const handle = value.startsWith("@") ? value.slice(1).trim() : null;
  const text = handle ?? value;
  if (text.length < MIN_NAME_SEARCH_LENGTH) return { kind: "too-short" };
  return handle === null ? { kind: "name", value: text } : { kind: "slack-handle", value: text };
}

const NameSearchForm: FC<{ name: string }> = ({ name }) => (
  <form method="get" action={MEMBERS_PATH}>
    <label for="name">Part of a name, or a Slack @handle</label>
    <input id="name" name="name" type="text" value={name} autocomplete="off" placeholder="@..." />
    <button type="submit">Find</button>
  </form>
);

const NameResults: FC<{ matches: NameMatch[] }> = ({ matches }) => (
  <>
    <p>
      {matches.length > NAME_SEARCH_LIMIT
        ? `More than ${NAME_SEARCH_LIMIT} people match; the first ${NAME_SEARCH_LIMIT} are below. More letters will narrow it down.`
        : `${matches.length} ${matches.length === 1 ? "person matches" : "people match"}.`}
    </p>
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <thead>
        <tr>
          {["Name on card", "Card #", "Email", "Slack", "Good through"].map((h) => (
            <th style={cellStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {matches.slice(0, NAME_SEARCH_LIMIT).map((match) => (
          <tr>
            <td style={cellStyle}>
              <a href={`${MEMBERS_PATH}?q=${encodeURIComponent(match.member_id)}`}>{cardNameText(match)}</a>
            </td>
            <td style={cellStyle}>{match.member_id}</td>
            <td style={cellStyle}>{match.email}</td>
            <td style={cellStyle}>{match.slack_handle ? `@${match.slack_handle}` : ""}</td>
            <td style={cellStyle}>
              {match.revoked
                ? "revoked or expelled"
                : match.expiration_date
                  ? formatShortDate(match.expiration_date)
                  : "no counted orders"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
);

/** Their Slack handle where the account has one, and whether it still works. */
function slackText(slack: EmailFootprint["slack"]): string {
  if (!slack) return "no match";
  const who = slack.handle ? `@${slack.handle}` : "matched";
  return slack.deleted ? `${who} (account deactivated)` : who;
}

const NAME_SET_BY: Record<string, string> = {
  member: "They set that name themselves",
  admin: "An admin set that name for them",
  legacy_postgres: "That name came across from the previous site",
};

/** Where the admin pages get a member's card image, by card number. */
export const CARD_PREVIEW_PATH = `${MEMBERS_PATH}/card.png`;

/**
 * The member's card as they see it now, for whoever is answering their
 * question: one look settles "what does my card say". Drawn by the same
 * code as their own card page (`renderCardImage()`), so it cannot differ
 * from it. Sized on the element for the same reason as there
 * (src/member/portal.tsx): a stale stylesheet cannot let it overflow.
 */
const CardPreview: FC<{ member: MemberRecord }> = ({ member }) => (
  <figure style="margin: 0; max-width: 26rem; flex: 1 1 18rem">
    <img
      src={`${CARD_PREVIEW_PATH}?id=${encodeURIComponent(member.member_id)}`}
      alt={`${cardNameText(member) || member.email}'s membership card`}
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      loading="lazy"
      style="width: 100%; height: auto; border-radius: 0.5rem"
    />
    <figcaption class="muted" style="font-size: 0.85rem">
      {member.revoked
        ? "Their card as drawn now. Their membership is revoked, so they cannot open it themselves."
        : "Their card as it looks to them now."}
    </figcaption>
  </figure>
);

/** What the admin page shows about a member's card theme. */
interface ThemeSummary {
  options: ThemeOptions;
  /** The theme their card is drawn in. */
  current: CardTheme;
  choice: ThemeChoice | null;
  /** Whether themes may be chosen at all yet (`CARD_THEME_CHOICE`). */
  open: boolean;
}

async function themeSummary(env: Env, member: MemberRecord): Promise<ThemeSummary> {
  const [options, choice, open] = await Promise.all([
    getThemeOptions(env, member),
    getCardThemeChoice(env, member.email),
    mayChooseTheme(env, true),
  ]);
  return { options, current: effectiveTheme(options, choice?.theme_id), choice, open };
}

/**
 * The subgroups they belong to now, each with the Slack channel that makes it
 * so: the groups whose themes they may use (`themeOptions()`), so "why can
 * they pick Los Pringles?" answers itself.
 */
const SubgroupsText: FC<{ theme: ThemeSummary }> = ({ theme }) => {
  const groups = CARD_GROUPS.filter((group) => theme.options.themes.some((option) => option.group === group.id));
  if (groups.length === 0) return <>none</>;
  return <>{groups.map((group) => `${group.label} (#${group.slackChannel})`).join(", ")}</>;
};

/** Any theme's label, including one this member can no longer use. */
function themeLabel(id: string): string {
  return CARD_THEMES.find((theme) => theme.id === id)?.label ?? id;
}

/**
 * Their card's theme (#333): what it is drawn in and why, and setting or
 * clearing it for them. Only themes they may use are offered, the same as on
 * their own page, and only while `CARD_THEME_CHOICE` lets anybody choose.
 */
const ThemeSection: FC<{ member: MemberRecord; theme: ThemeSummary }> = ({ member, theme }) => {
  const { options, current, choice, open } = theme;
  const why = !choice
    ? "their default, as nobody has chosen one"
    : choice.theme_id !== current.id
      ? `their default: "${themeLabel(choice.theme_id)}" was chosen, but it is not one they can use any more`
      : choice.source === "member"
        ? "which they chose themselves"
        : `which an admin chose for them${choice.set_by_email ? ` (${choice.set_by_email})` : ""}`;
  return (
    <>
      <h3>Their card's theme</h3>
      <p>
        Drawn in <strong>{current.label}</strong>, {why}. They may use{" "}
        {options.themes.map((option) => option.label).join(", ")}.
      </p>
      {open ? (
        <>
          <form method="post" action={MEMBERS_PATH}>
            <input type="hidden" name="email" value={member.email} />
            <input type="hidden" name="action" value="theme" />
            <label for="theme">Theme</label>
            <select id="theme" name="theme">
              {options.themes.map((option) => (
                <option value={option.id} selected={option.id === current.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type="submit">Use this theme</button>
          </form>
          {choice && (
            <form method="post" action={MEMBERS_PATH}>
              <input type="hidden" name="email" value={member.email} />
              <input type="hidden" name="action" value="theme-clear" />
              <button type="submit">Go back to their default ({options.defaultTheme.label})</button>
            </form>
          )}
        </>
      ) : (
        <p class="muted">Choosing a theme is switched off (CARD_THEME_CHOICE).</p>
      )}
    </>
  );
};

/**
 * The store account (#38) connected to this member's user: the user signed
 * in under their address, or the one who claimed the membership.
 */
interface StoreAccountRow {
  userId: number;
  customerId: number | null;
  linkedAt: number | null;
}

async function storeAccountForMember(env: Env, member: MemberRecord): Promise<StoreAccountRow | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.bigcommerce_id, u.bigcommerce_linked_at FROM users u
      WHERE u.email = ?1 OR u.id = (SELECT user_id FROM members WHERE member_id = ?2)
      ORDER BY u.email = ?1 DESC LIMIT 1`,
  )
    .bind(member.email, member.member_id)
    .first<{ id: number; bigcommerce_id: number | null; bigcommerce_linked_at: number | null }>();
  return row ? { userId: row.id, customerId: row.bigcommerce_id, linkedAt: row.bigcommerce_linked_at } : null;
}

/** What revoking or expelling does, said where it is asked for and again before it happens. */
const STANDING_ACTIONS = {
  revoke: {
    button: "Revoke this membership",
    question: "Revoke this membership?",
    field: "revocation_note",
    label: "Reason for revoking",
    maxLength: MAX_REVOCATION_NOTE_LENGTH,
    effect:
      "Their card stops counting as current straight away, everywhere it is checked, and their installed passes are told. They can still sign in. Their orders are untouched, and it can be restored from their page.",
  },
  expel: {
    button: "Expel this person from the group",
    question: "Expel this person from the group?",
    field: "expulsion_note",
    label: "Reason for expelling",
    maxLength: MAX_EXPULSION_NOTE_LENGTH,
    effect:
      "Their card stops counting as current, and they can no longer sign in here, including on sessions they already have. A new order under this address doesn't bring it back. Their orders are untouched, and it can be lifted from their page.",
  },
} as const;

type StandingAction = keyof typeof STANDING_ACTIONS;

/**
 * Revoking or expelling. From the member page it only asks (the page that
 * answers says what it does); from that page, with `confirmed`, it acts.
 */
const StandingForm: FC<{ action: StandingAction; email: string; note: string; confirmed?: boolean }> = ({
  action,
  email,
  note,
  confirmed,
}) => {
  const what = STANDING_ACTIONS[action];
  return (
    <form method="post" action={MEMBERS_PATH}>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="action" value={action} />
      {confirmed && <input type="hidden" name="confirmed" value="1" />}
      <label for={what.field}>
        {what.label}
        <span class="hint">Optional · Kept on the record</span>
      </label>
      <input id={what.field} name={what.field} type="text" value={note} maxlength={what.maxLength} autocomplete="off" />
      <button type="submit" class="danger">
        {what.button}
      </button>{" "}
      {confirmed && <a href={`${MEMBERS_PATH}?${new URLSearchParams({ q: email })}`}>Cancel</a>}
    </form>
  );
};

/** The page that asks once more before a revocation or expulsion, saying what it does. */
const ConfirmStanding: FC<{ action: StandingAction; email: string; name: string; memberId: string | null; note: string }> = ({
  action,
  email,
  name,
  memberId,
  note,
}) => {
  const what = STANDING_ACTIONS[action];
  return (
    <AdminPage title={what.question}>
      <p>
        <strong>{name || email}</strong>
        {name ? ` (${email})` : ""}
        {memberId ? `, card ${memberId}` : ""}.
      </p>
      <p>{what.effect}</p>
      <p class="muted">The Membership Committee's decision. It is recorded in the audit log, with the reason.</p>
      <StandingForm action={action} email={email} note={note} confirmed />
    </AdminPage>
  );
};

const StoreAccountCell: FC<{ member: MemberRecord; store: StoreAccountRow | null }> = ({ member, store }) =>
  store?.customerId ? (
    <form method="post" action={MEMBERS_PATH} class="inline">
      <StoreCustomerLink customerId={store.customerId} />
      {store.linkedAt ? `, connected ${dayText(store.linkedAt)}` : ""}{" "}
      <input type="hidden" name="email" value={member.email} />
      <input type="hidden" name="action" value="store-unlink" />
      <input type="hidden" name="user_id" value={String(store.userId)} />
      <button type="submit" class="quiet danger">
        Disconnect
      </button>
    </form>
  ) : (
    <>{store ? "not connected" : "no account here yet"}</>
  );

/**
 * What MiniBC says about their renewal: one line per subscription, the one
 * that decides it first. A subscription only their address points to (#470)
 * comes last, labelled as such, since no order ties it to them.
 */
const RenewalCell: FC<{ member: MemberRecord; renewals: RenewalRow[] }> = ({ member, renewals }) => {
  if (renewals.length === 0) return <>Doesn't renew automatically</>;
  const matched = renewals.filter((row) => row.member_email !== null);
  const byAddress = renewals.filter((row) => row.member_email === null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      {matched.length === 0 && <div>Doesn't renew automatically</div>}
      {matched.map((row, i) => {
        const state = renewalState(row, member.expiration_date, today);
        const worrying = state.kind === "overdue" || state.kind === "renews-late";
        return (
          <div>
            {i > 0 && <span class="muted">Also: </span>}
            <span style={worrying ? "color: var(--danger)" : undefined}>{renewalText(state)}</span>{" "}
            <span class="muted">(MiniBC subscription {row.subscription_id})</span>
          </div>
        );
      })}
      {byAddress.map((row) => (
        <div>
          <span class="muted">By address only, no order ties it to them: </span>
          {renewalText(renewalState(row, member.expiration_date, today))}{" "}
          <span class="muted">
            (MiniBC subscription {row.subscription_id}
            {row.store_customer_id ? "" : ", a guest checkout"})
          </span>
        </div>
      ))}
    </>
  );
};

const Summary: FC<{
  member: MemberRecord;
  footprint: EmailFootprint;
  orders: MemberOrder[];
  nameSetBy: string | null;
  nameSetByEmail: string | null;
  expelled: boolean;
  theme: ThemeSummary;
  store: StoreAccountRow | null;
  /** MiniBC subscriptions matched to them (#397); null where MiniBC isn't read. */
  renewals: RenewalRow[] | null;
  memberSince: MemberSinceSubject;
  today: string;
}> = ({ member, footprint, orders, nameSetBy, nameSetByEmail, expelled, theme, store, renewals, memberSince, today }) => (
  <>
    {member.display_name && (
      <p class="muted">
        {(nameSetBy && NAME_SET_BY[nameSetBy]) ?? "That name was set for them"}
        {nameSetByEmail ? ` (${nameSetByEmail})` : ""}; their orders say{" "}
        {`${member.first_name} ${member.last_name}`.trim() || "nothing"}.
      </p>
    )}
    <div style="display: flex; flex-wrap: wrap; gap: 1rem 2rem; align-items: flex-start">
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <tbody>
        <tr>
          <th style={cellStyle}>Card #</th>
          <td style={cellStyle}>{member.member_id}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Email</th>
          <td style={cellStyle}>{member.email}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Good through</th>
          <td style={cellStyle}>
            {member.expiration_date ? formatShortDate(member.expiration_date) : "no counted orders"}
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Member since</th>
          <td style={cellStyle}>
            {member.member_since ? formatShortDate(member.member_since) : "not shown"}
            {memberSince.override ? (
              <>
                {" "}
                (<a href="#member-since">corrected</a>)
              </>
            ) : (
              ""
            )}
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Orders</th>
          <td style={cellStyle}>
            {footprint.memberOrders.counted} of {footprint.memberOrders.total} count
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Signed in before</th>
          <td style={cellStyle}>{footprint.login ? "yes" : "no"}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Slack</th>
          <td style={cellStyle}>
            {slackText(footprint.slack)}
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Subgroups</th>
          <td style={cellStyle}>
            <SubgroupsText theme={theme} />
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Store account</th>
          <td style={cellStyle}>
            <StoreAccountCell member={member} store={store} />
          </td>
        </tr>
        {renewals && (
          <tr>
            <th style={cellStyle}>Renewal</th>
            <td style={`${cellStyle}; white-space: normal; max-width: 28rem`}>
              <RenewalCell member={member} renewals={renewals} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
    <CardPreview member={member} />
    </div>
    <h3>The name on their card</h3>
    <p>
      Shown instead of the name their orders give. Useful for a gifted membership,
      where the card carries the buyer's name until the recipient orders something
      of their own -- and for anyone who asks for a correction rather than making it
      themselves.
    </p>
    <form method="post" action={MEMBERS_PATH}>
      <input type="hidden" name="email" value={member.email} />
      <label for="display_name">Name to show</label>
      <input
        id="display_name"
        name="display_name"
        type="text"
        value={member.display_name ?? ""}
        maxlength={MAX_DISPLAY_NAME_LENGTH}
        placeholder={`${member.first_name} ${member.last_name}`.trim()}
        autocomplete="off"
      />
      <label for="note">
        Why<span class="hint">Optional · Kept for whoever asks later</span>
      </label>
      <input id="note" name="note" type="text" maxlength={200} autocomplete="off" />
      <button type="submit">Save</button>
    </form>
    {member.display_name && (
      <form method="post" action={MEMBERS_PATH}>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="clear" />
        <button type="submit">Use the name from their orders instead</button>
      </form>
    )}
    <MemberSinceSection subject={memberSince} today={today} />
    <ThemeSection member={member} theme={theme} />
    <h3>Membership standing</h3>
    <p class="muted">
      Rarely needed, and the Membership Committee's decision. Revoking stops this card; expelling also
      stops the person signing in. Either can be lifted, and their orders are untouched.
    </p>
    {member.revoked ? (
      <form method="post" action={MEMBERS_PATH}>
        <p class="danger">
          <strong>This membership has been revoked.</strong>
        </p>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="restore" />
        <button type="submit">Restore this membership</button>
      </form>
    ) : (
      <details class="danger-zone">
        <summary>Revoke this membership…</summary>
        <StandingForm action="revoke" email={member.email} note="" />
      </details>
    )}
    {expelled ? (
      <form method="post" action={MEMBERS_PATH}>
        <p class="danger">
          <strong>This person has been expelled from Los Verdes.</strong>
        </p>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="readmit" />
        <button type="submit">Lift this expulsion</button>
      </form>
    ) : (
      <details class="danger-zone">
        <summary>Expel this person from the group…</summary>
        <StandingForm action="expel" email={member.email} note="" />
      </details>
    )}
    <h3>Their orders</h3>
    {orders.length === 0 ? (
      <p>No orders are attributed to this address.</p>
    ) : (
      <OrdersTable email={member.email} orders={orders} />
    )}
  </>
);

/**
 * An address's orders. With more than one, a link to move them all to
 * another address at once (src/admin/moveOrders.tsx), rather than from each
 * order's own page in turn.
 */
const OrdersTable: FC<{ email: string; orders: MemberOrder[] }> = ({ email, orders }) => (
  <>
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <thead>
        <tr>
          {["Order", "Product", "Status", "Placed", "Counts", ""].map((h) => (
            <th style={cellStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr>
            <td style={cellStyle}>
              <OrderLink orderId={order.order_id} /> <StoreOrderLink orderId={order.order_id} source={order.source}>store</StoreOrderLink>
            </td>
            <td style={cellStyle}>{order.product_name ?? ""}</td>
            <td style={cellStyle}>{order.status ?? ""}</td>
            <td style={cellStyle}>{order.created_on.slice(0, 10)}</td>
            <td style={cellStyle}>{order.counts ? "yes" : "no"}</td>
            <td style={cellStyle}>
              {order.source === "bigcommerce" && <RereadButton orderId={order.order_id} from="member" />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {orders.length > 1 && (
      <p>
        <a href={moveOrdersPath({ from: email })}>Move all {orders.length} orders to another address</a>
      </p>
    )}
  </>
);

/** An order placed with an address and since pointed at somebody else. */
interface MovedOrder {
  order_id: string;
  member_email: string;
}

async function ordersMovedAway(db: D1Database, email: string): Promise<MovedOrder[]> {
  const { results } = await db
    .prepare(
      `SELECT order_id, member_email FROM membership_orders
       WHERE order_email = ?1 AND member_email != ?1
       ORDER BY created_on DESC, order_id DESC`,
    )
    .bind(email)
    .all<MovedOrder>();
  return results;
}

/**
 * An address that holds orders and no membership
 * (los-verdes/card-losverd-es#241). "No membership is held under that
 * address" is true of it and tells whoever is answering the member nothing
 * they can act on, and it is exactly the state somebody writes in about:
 * every order refunded, an order pointed at somebody else, or -- before an
 * environment's first full resync -- orders that count whose membership has
 * simply not been built yet.
 */
const OrdersWithoutMember: FC<{
  email: string;
  footprint: EmailFootprint;
  orders: MemberOrder[];
  moved: MovedOrder[];
}> = ({ email, footprint, orders, moved }) => (
  <>
    <p>
      <strong>No membership is held under this address</strong>, but it is not unknown.
      Orders attributed to it: {footprint.memberOrders.total}. Counting towards a
      membership: {footprint.memberOrders.counted}.
    </p>
    {footprint.memberOrders.counted > 0 ? (
      <p>
        An order that counts and no membership means the membership has not been built
        yet. That happens for orders loaded by the one-time import until the order sync
        next reads this person's orders, and it puts itself right when it does.
      </p>
    ) : (
      footprint.memberOrders.total > 0 && (
        <p>
          None of them counts, which is why there is no card. The status beside each says
          why: only a paid order confers a membership, and a refunded or cancelled one
          stops conferring it.
        </p>
      )
    )}
    {orders.length > 0 && <OrdersTable email={email} orders={orders} />}
    {moved.length > 0 && (
      <>
        <h3>Placed with this address, and since pointed at somebody else</h3>
        <p>
          These feed another person's card now -- a gift, or an address they no longer
          use. The order page says who moved it and when.
        </p>
        <ul>
          {moved.map((order) => (
            <li>
              <OrderLink orderId={order.order_id} />, now attributed to{" "}
              <a href={`${MEMBERS_PATH}?q=${encodeURIComponent(order.member_email)}`}>
                {order.member_email}
              </a>
            </li>
          ))}
        </ul>
      </>
    )}
    <p class="muted">
      Signed in before: {footprint.login ? "yes" : "no"}. Slack:{" "}
      {slackText(footprint.slack)}.
    </p>
  </>
);

/**
 * A member's card image, for the preview on their page. Found by card number
 * rather than address, so no address goes into a URL. Drawn on demand like
 * the member's own, and never counted as them viewing it.
 */
members.get("/card.png", async (c) => {
  const member = await getMemberById(c.env, c.req.query("id") ?? "");
  if (!member) return c.text("No membership carries that card number.", 404);
  // `&theme=` previews one of the themes they may use.
  const themeId = c.req.query("theme");
  const theme =
    themeId === undefined
      ? undefined
      : (await getThemeOptions(c.env, member)).themes.find((option) => option.id === themeId);
  if (themeId !== undefined && !theme) return c.text("That is not a theme this card can use.", 404);
  const png = await renderCardImage(c.env, member, theme, (work) => c.executionCtx.waitUntil(work));
  // See sha1Hex in src/passkit/generator.ts for why this narrowing is needed.
  return new Response(png as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  });
});

members.get("/", async (c) => {
  const lookup = classify(c.req.query("q") ?? "");

  // An order number identifies a purchase rather than a person, and there is
  // already a page for one, so this hands over rather than reimplementing it.
  if (lookup.kind === "order") {
    return c.redirect(orderPath(lookup.value), 303);
  }

  let member: MemberRecord | null = null;
  let notFound: string | null = null;
  if (lookup.kind === "email") {
    member = isWellFormedEmail(lookup.value)
      ? await getMemberByEmail(c.env, lookup.value)
      : null;
  } else if (lookup.kind === "card") {
    member = await getMemberById(c.env, lookup.value);
    if (!member) notFound = "No membership carries that card number.";
  }

  // Whatever the audit log holds about the address, whether or not it still
  // has a card or orders: an expulsion can outlive both, and every address
  // the audit log shows links here (#359).
  const historyEmail =
    member?.email ?? (lookup.kind === "email" && isWellFormedEmail(lookup.value) ? lookup.value : null);

  const [footprint, orders, override, expelled, theme, store, renewals, memberSince] = member
    ? await Promise.all([
        emailFootprint(c.env.DB, member.email),
        getMemberOrderHistory(c.env, member.email),
        getDisplayName(c.env, member.email),
        isExpelled(c.env, member.email),
        themeSummary(c.env, member),
        storeAccountForMember(c.env, member),
        // Only where MiniBC is read at all: elsewhere "doesn't renew" would be a guess.
        c.env.MINIBC_API_KEY ? renewalsForMember(c.env, member.email) : Promise.resolve(null),
        lookupMemberSince(c.env, member.email),
      ])
    : [null, [], null, false, null, null, null, null];

  // An address can hold orders and no membership, and that is a real answer
  // rather than a dead end (#241). Only when there is nothing at all does the
  // page fall back to saying so.
  let orphan: { email: string; footprint: EmailFootprint; orders: MemberOrder[]; moved: MovedOrder[] } | null = null;
  if (lookup.kind === "email" && !member) {
    if (isWellFormedEmail(lookup.value)) {
      const [orphanFootprint, orphanOrders, moved] = await Promise.all([
        emailFootprint(c.env.DB, lookup.value),
        getMemberOrderHistory(c.env, lookup.value),
        ordersMovedAway(c.env.DB, lookup.value),
      ]);
      if (orphanOrders.length > 0 || moved.length > 0) {
        orphan = { email: lookup.value, footprint: orphanFootprint, orders: orphanOrders, moved };
      }
    }
  }
  const history: AuditEntry[] | null = historyEmail ? await readWholeAuditLog(c.env, { email: historyEmail }) : null;
  // Nothing but history: somebody the log remembers, with no card or orders
  // left to show -- still a page, so no link from the audit log dead-ends.
  const historyOnly = lookup.kind === "email" && !member && !orphan && history !== null && history.length > 0;
  if (lookup.kind === "email" && !member && !orphan && !historyOnly) {
    notFound = "No membership is held under that address, and no orders either.";
  }

  // One more than is shown, so the page can say there were more.
  const nameSearch = parseNameSearch(c.req.query("name") ?? "");
  const nameMatches =
    nameSearch.kind === "name" || nameSearch.kind === "slack-handle"
      ? await findMembersByName(c.env, nameSearch.value, {
          slackHandleOnly: nameSearch.kind === "slack-handle",
          limit: NAME_SEARCH_LIMIT + 1,
        })
      : null;
  if (nameSearch.kind === "too-short") {
    notFound = `Type at least ${MIN_NAME_SEARCH_LENGTH} letters of a name.`;
  } else if (nameMatches?.length === 0) {
    notFound =
      nameSearch.kind === "slack-handle"
        ? "Nobody with a membership has a Slack handle containing that."
        : "Nobody with a membership has a name or Slack handle containing that.";
  }

  // Following a link from a report lands here, so the heading says whose page
  // this is; the search forms follow the details rather than leading them.
  const searchForms = (
    <>
      <SearchForm q={c.req.query("q") ?? ""} />
      <NameSearchForm name={c.req.query("name") ?? ""} />
    </>
  );
  const title = member
    ? `Member: ${cardNameText(member) || member.email}`
    : orphan
      ? `Address: ${orphan.email}`
      : historyOnly
        ? `Address: ${historyEmail}`
        : "Find a member";
  const found = member !== null || orphan !== null || historyOnly;

  return c.html(
    <AdminPage title={title}>
      {member && (
        <p class="muted">
          A member: one person in Los Verdes, and the card they carry. Their card is worked out from all of the
          membership orders attributed to their address, listed below, together with anything set here by hand. Each
          order has a page of its own.
        </p>
      )}
      {!found && (
        <>
          <p>
            The card number is on the back of every pass, so it is the one thing a member can
            always read out. An order number goes straight to that order.
          </p>
          {searchForms}
        </>
      )}
      {nameMatches && nameMatches.length > 0 && <NameResults matches={nameMatches} />}
      {c.req.query("saved") === "set" && (
        <p style="color: var(--success)">Name saved. Their passes will catch up shortly.</p>
      )}
      {c.req.query("saved") === "member-since" && (
        <p style="color: var(--success)">&quot;Member since&quot; corrected. Their card will show it from now on.</p>
      )}
      {c.req.query("saved") === "member-since-cleared" && (
        <p style="color: var(--success)">Correction removed. Their card is back to the date from their orders.</p>
      )}
      {c.req.query("saved") === "store-unlinked" && (
        <p style="color: var(--success)">Store account disconnected.</p>
      )}
      {c.req.query("saved") === "theme" && (
        <p style="color: var(--success)">Theme saved. Their passes will catch up shortly.</p>
      )}
      {c.req.query("saved") === "theme-cleared" && (
        <p style="color: var(--success)">Theme cleared. Their card is back to its default.</p>
      )}
      {c.req.query("saved") === "revoked" && (
        <p style="color: var(--success)">Membership revoked.</p>
      )}
      {c.req.query("saved") === "expelled" && (
        <p style="color: var(--success)">Expelled from the group.</p>
      )}
      {c.req.query("saved") === "readmitted" && (
        <p style="color: var(--success)">Expulsion lifted.</p>
      )}
      {c.req.query("saved") === "restored" && (
        <p style="color: var(--success)">
          Membership restored, to whatever their orders say.
        </p>
      )}
      {c.req.query("saved") === "cleared" && (
        <p style="color: var(--success)">
          Name removed. Their card is back to the name their orders give.
        </p>
      )}
      {rereadMessage(c.req.query("reread")) && (
        <p class="muted">
          Order {c.req.query("order")}: {rereadMessage(c.req.query("reread"))}
        </p>
      )}
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {notFound && <p style="color: var(--danger)">{notFound}</p>}
      {orphan && <OrdersWithoutMember {...orphan} />}
      {member && footprint && theme && memberSince && (
        <Summary
          member={member}
          footprint={footprint}
          orders={orders}
          nameSetBy={override?.source ?? null}
          nameSetByEmail={override?.set_by_email ?? null}
          expelled={expelled}
          theme={theme}
          store={store}
          renewals={renewals}
          memberSince={memberSince}
          today={new Date().toISOString().slice(0, 10)}
        />
      )}
      {historyOnly && (
        <p>
          <strong>No membership or orders are held under this address</strong>, but the audit
          log remembers it.
        </p>
      )}
      {found && history && historyEmail && <AuditHistory email={historyEmail} entries={history} />}
      {found && (
        <>
          <h2>Find someone else</h2>
          {searchForms}
        </>
      )}
    </AdminPage>,
  );
});

/**
 * Setting a name on somebody's behalf. Redirects back to this member rather
 * than rendering, so a refresh does not resubmit and the saved message is on
 * the page the admin was already looking at.
 */
members.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
  const back = (params: Record<string, string>) =>
    c.redirect(`${MEMBERS_PATH}?${new URLSearchParams({ q: email, ...params })}`, 303);

  if (!email) return back({ error: "No member to set a name for." });

  // Revoking and expelling ask once more first, on a page of their own.
  if ((form.action === "revoke" || form.action === "expel") && form.confirmed !== "1") {
    const action: StandingAction = form.action;
    const member = await getMemberByEmail(c.env, email);
    if (action === "revoke" && !member) return back({ error: "No membership is held under that address." });
    const typed = form[STANDING_ACTIONS[action].field];
    return c.html(
      <ConfirmStanding
        action={action}
        email={email}
        name={member ? cardNameText(member) : ""}
        memberId={member?.member_id ?? null}
        note={typeof typed === "string" ? typed.trim() : ""}
      />,
    );
  }

  if (form.action === "expel" || form.action === "readmit") {
    if (form.action === "readmit") {
      return (await readmitPerson(c.env, email, c.get("session").userId))
        ? back({ saved: "readmitted" })
        : back({ error: "That person has not been expelled." });
    }
    const note =
      typeof form.expulsion_note === "string" && form.expulsion_note.trim() !== ""
        ? form.expulsion_note.trim()
        : null;
    return (await expelPerson(c.env, email, note, c.get("session").userId))
      ? back({ saved: "expelled" })
      : back({ error: "That person has already been expelled." });
  }

  if (form.action === "revoke" || form.action === "restore") {
    const member = await getMemberByEmail(c.env, email);
    if (!member) return back({ error: "No membership is held under that address." });

    if (form.action === "restore") {
      return (await restoreCard(c.env, member.member_id, c.get("session").userId))
        ? back({ saved: "restored" })
        : back({ error: "That membership has not been revoked." });
    }

    const note =
      typeof form.revocation_note === "string" && form.revocation_note.trim() !== ""
        ? form.revocation_note.trim()
        : null;
    return (await revokeCard(c.env, member.member_id, note, c.get("session").userId))
      ? back({ saved: "revoked" })
      : back({ error: "That membership has already been revoked." });
  }

  if (form.action === "store-unlink") {
    const userId = Number(form.user_id);
    if (!Number.isInteger(userId) || !(await unlinkStoreAccount(c.env, userId, c.get("session").userId))) {
      return back({ error: "There was no store account to disconnect." });
    }
    return back({ saved: "store-unlinked" });
  }

  if (form.action === "theme" || form.action === "theme-clear") {
    if (!(await mayChooseTheme(c.env, true))) return back({ error: "Choosing a theme is switched off." });
    const member = await getMemberByEmail(c.env, email);
    if (!member) return back({ error: "No membership is held under that address." });
    if (form.action === "theme-clear") {
      await clearCardTheme(c.env, email, "admin", c.get("session").userId);
      return back({ saved: "theme-cleared" });
    }
    try {
      await setCardTheme(c.env, member, typeof form.theme === "string" ? form.theme : "", "admin", c.get("session").userId);
    } catch (err) {
      if (!(err instanceof ThemeNotAllowed)) throw err;
      return back({ error: "That is not a theme their card can use." });
    }
    return back({ saved: "theme" });
  }

  if (form.action === "member-since") {
    const input = parseMemberSince(email, form.member_since, form.note, new Date().toISOString().slice(0, 10));
    if ("error" in input) return back({ error: input.error });
    await saveMemberSince(c.env, input, c.get("session").userId);
    return back({ saved: "member-since" });
  }

  if (form.action === "member-since-clear") {
    return (await clearMemberSince(c.env, email, c.get("session").userId))
      ? back({ saved: "member-since-cleared" })
      : back({ error: "There was no correction to remove." });
  }

  if (form.action === "clear") {
    const existing = await getDisplayName(c.env, email);
    if (!existing) return back({ error: "There was no name to remove." });
    await clearDisplayName(c.env, email, c.get("session").userId);
    return back({ saved: "cleared" });
  }

  const result = normalizeDisplayName(
    typeof form.display_name === "string" ? form.display_name : "",
  );
  if (!result.ok) return back({ error: result.reason });

  const note = typeof form.note === "string" && form.note.trim() !== "" ? form.note.trim() : null;
  // `source = 'admin'` rather than 'member': it records who to point at when
  // somebody asks why their card says what it says.
  await setDisplayName(c.env, email, result.value, "admin", note, c.get("session").userId);
  return back({ saved: "set" });
});

export default members;
