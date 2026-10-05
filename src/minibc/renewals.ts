/**
 * What MiniBC's subscriptions (src/minibc/subscriptions.ts) say about each
 * member's renewal, for admins (#397): on their member page, and on the
 * Renewals report.
 *
 * A subscription is matched to a member through orders, never an address:
 *
 * 1. the latest membership order carrying its id (`minibc_subscription_id`,
 *    written onto each order MiniBC creates, where MiniBC's order metafields
 *    are on);
 * 2. the order that started it, or MiniBC's `origin_order_id`;
 * 3. the latest membership order its store customer placed for themselves --
 *    one still attributed to the address it was bought under, so a gift the
 *    buyer paid for never puts the buyer's subscription on the recipient.
 *
 * Through an order, it follows that order's attribution: a gift re-attributed
 * to its recipient carries the subscription with it.
 *
 * One more thing is offered, and only as a hint (#470): for a subscription no
 * order matches, the member whose address is MiniBC's email for it, if any
 * (`address_member_email`). That is most often a renewal started from a guest
 * checkout, which has no store customer to follow. It is shown apart, labelled
 * as by address only, and never counts as the subscription's member.
 *
 * All of this is informational. It never changes a card.
 */

import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";

/** One subscription, with the member it was matched to, if any. */
export interface RenewalRow {
  [key: string]: string | number | null;
  subscription_id: number;
  status: string;
  signup_on: string | null;
  next_payment_on: string | null;
  paused_on: string | null;
  cancelled_on: string | null;
  order_id: number | null;
  store_customer_id: number | null;
  /** The SKU MiniBC lists it under, which says what it is for. */
  sku: string;
  member_email: string | null;
  member_id: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  /** The member's card's "good through" date; null without a member, or without counted orders. */
  expiration_date: string | null;  /**
   * For a subscription no order matches: the member whose address is MiniBC's
   * email for it, as a hint only. Null when an order matches, or no member has it.
   */
  address_member_email: string | null;
  /** That member's "good through" date, for saying what happens next. */
  address_expiration_date: string | null;
}

const RENEWALS_SQL = `
  WITH matched AS (
    SELECT s.*,
      COALESCE(
        (SELECT o.member_email FROM membership_orders o
          WHERE o.minibc_subscription_id = s.subscription_id ORDER BY o.created_on DESC LIMIT 1),
        (SELECT o.member_email FROM membership_orders o WHERE o.order_id = CAST(s.order_id AS TEXT)),
        (SELECT o.member_email FROM membership_orders o WHERE o.order_id = CAST(s.origin_order_id AS TEXT)),
        (SELECT o.member_email FROM membership_orders o
          WHERE o.customer_id = s.store_customer_id AND o.member_email = o.order_email
          ORDER BY o.created_on DESC LIMIT 1)
      ) AS matched_email
    FROM minibc_subscriptions s
    WHERE s.missing_since IS NULL
  )
  SELECT m.subscription_id, m.status, m.signup_on, m.next_payment_on, m.paused_on, m.cancelled_on,
         m.order_id, m.store_customer_id, m.sku, m.matched_email AS member_email,
         mem.member_id, mem.first_name, mem.last_name, dn.display_name, mem.expiration_date,
         byaddr.email AS address_member_email, byaddr.expiration_date AS address_expiration_date
    FROM matched m
    LEFT JOIN members mem ON mem.email = m.matched_email
    LEFT JOIN member_display_names dn ON dn.email = m.matched_email
    LEFT JOIN members byaddr ON m.matched_email IS NULL AND byaddr.email = m.customer_email`;

/** Every subscription MiniBC still lists, each with its member. */
export async function allRenewals(env: Env): Promise<RenewalRow[]> {
  const { results } = await env.DB.prepare(`${RENEWALS_SQL} ORDER BY m.next_payment_on IS NULL, m.next_payment_on, m.subscription_id`).all<RenewalRow>();
  return results;
}

/**
 * The subscriptions matched to one member, active first, then any that only
 * share their address (`address_member_email`), as hints.
 */
export async function renewalsForMember(env: Env, email: string): Promise<RenewalRow[]> {
  const { results } = await env.DB.prepare(
    `${RENEWALS_SQL} WHERE m.matched_email = ?1 OR byaddr.email = ?1
     ORDER BY m.matched_email IS NULL, m.status = 'active' DESC, m.next_payment_on DESC, m.subscription_id DESC`,
  )
    .bind(email.trim().toLowerCase())
    .all<RenewalRow>();
  return results;
}

/** When the last complete read of MiniBC finished (epoch ms), or null if none has. */
export async function lastRenewalsRead(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT updated_at FROM etl_sync_state WHERE job_name = 'sync_minibc_subscriptions_etl'").first<{
    updated_at: number;
  }>();
  return row?.updated_at ?? null;
}

/**
 * A renewal a day after the card runs out is on time: a card runs 365 days
 * from its order, and MiniBC renews on the anniversary, which in a year with
 * 29 February is a day later. Anything later leaves the member without a
 * current card in between.
 */
export const RENEWAL_ON_TIME_DAYS = 1;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

export type RenewalState =
  /** Active, and next charged no later than the card runs out (or a day after). */
  | { kind: "renews"; on: string }
  /** Active, card still current, but next charged well after it runs out. */
  | { kind: "renews-late"; on: string; cardEnds: string; daysAfter: number }
  /** Active, but the card has already run out: the renewal failed or is still to be tried. */
  | { kind: "overdue"; cardEnded: string | null; nextTry: string | null }
  | { kind: "paused"; since: string | null }
  | { kind: "cancelled"; on: string | null };

/** What a subscription means for a member whose card is good through `expiration` (null: no counted orders). */
export function renewalState(row: Pick<RenewalRow, "status" | "next_payment_on" | "paused_on" | "cancelled_on">, expiration: string | null, today: string): RenewalState {
  if (row.status === "paused") return { kind: "paused", since: row.paused_on };
  if (row.status !== "active") return { kind: "cancelled", on: row.cancelled_on };
  if (!expiration || expiration < today) return { kind: "overdue", cardEnded: expiration, nextTry: row.next_payment_on };
  if (!row.next_payment_on) return { kind: "overdue", cardEnded: null, nextTry: null };
  const late = daysBetween(expiration, row.next_payment_on);
  return late > RENEWAL_ON_TIME_DAYS
    ? { kind: "renews-late", on: row.next_payment_on, cardEnds: expiration, daysAfter: late }
    : { kind: "renews", on: row.next_payment_on };
}

/**
 * The membership card's last day minus MiniBC's next payment, in days:
 * negative when the card runs out before the renewal, positive when the
 * renewal comes first. Null unless the subscription is active and both dates
 * are known.
 */
export function expiryMinusRenewalDays(row: Pick<RenewalRow, "status" | "next_payment_on">, expiration: string | null): number | null {
  if (row.status !== "active" || !expiration || !row.next_payment_on) return null;
  return daysBetween(row.next_payment_on, expiration);
}

/** The same, as a table shows it: signed, "+3", "-12" or "0". */
export function expiryMinusRenewalText(days: number | null): string {
  return days === null ? "" : days > 0 ? `+${days}` : String(days);
}

/** A state in a line an admin reads: what happens next, and when. */
export function renewalText(state: RenewalState): string {
  const date = (iso: string | null) => (iso ? formatShortDate(iso) : "no date");
  switch (state.kind) {
    case "renews":
      return `Renews automatically on ${date(state.on)}`;
    case "renews-late":
      return `Renews automatically on ${date(state.on)}, ${state.daysAfter} days after the membership card runs out on ${date(state.cardEnds)}`;
    case "overdue":
      return `${state.cardEnded ? `Membership card ran out on ${date(state.cardEnded)}` : "No current membership card"}, but automatic renewal is still on: ${
        state.nextTry ? `MiniBC's next payment is on ${date(state.nextTry)}` : "MiniBC has no next payment date"
      }`;
    case "paused":
      return `Automatic renewal paused${state.since ? ` since ${date(state.since)}` : ""}`;
    case "cancelled":
      return `Automatic renewal cancelled${state.on ? ` on ${date(state.on)}` : ""}`;
  }
}
