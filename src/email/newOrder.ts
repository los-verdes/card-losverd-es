/**
 * Emailing a member their card when a new membership order is paid for
 * (los-verdes/card-losverd-es#70), so a new member never has to visit the
 * site at all.
 *
 * The danger this file is built around: emailing cards must never happen in
 * bulk. A backfill, a scheduled resync, or a data import or reload
 * would otherwise mail hundreds of existing members at once. Three guards:
 *
 * 1. **Webhook path only.** This is called from `syncBigCommerceOrder`, the
 *    path a BigCommerce order webhook takes. The scheduled resync and
 *    `loadAll` full resync go through `applyMembershipOrder` directly and
 *    never reach here; the legacy import wrote D1 without running any of it.
 *    Sufficient on its own.
 * 2. **A cutoff date.** `CARD_EMAIL_NEW_ORDERS_SINCE` (a plain var, empty by
 *    default) switches sending on, and only orders created on or after it are
 *    eligible. Sufficient on its own *provided it is set to the day sending
 *    is switched on and never backdated*; an unparseable value turns sending
 *    off rather than letting everything through.
 * 3. **A sent log.** `card_emails` is claimed before the
 *    send, so a webhook retry, a duplicate delivery, or two deliveries at
 *    once can't send a second copy. Sufficient on its own to keep it to one
 *    email per order.
 *
 * An order qualifies while it counts as a membership at all --
 * `PAID_BIGCOMMERCE_STATUSES`, the same list the card, the QR code and the
 * wallet passes go by. Deliberately the same list and not a second one: a
 * card that verifies is a card its member should have been told about, and
 * while these two disagreed, every order left sitting in `Shipped` had a
 * working membership card nobody had mentioned to them.
 *
 * It waited for `Completed` until 2026-09-22, to let the email follow the
 * membership pack out the door. In this store `Completed` is set by hand and
 * often never reached, so in practice the email was waiting on a step that
 * does not come.
 *
 * There is deliberately no "did it just become paid" check: the sent log
 * already bounds this to one email, and a status this code compared against
 * could have been written by a queue retry or an earlier resync, which would
 * drop the email entirely.
 */

import { bigCommerceOrderKey } from "../bigcommerce/orders";
import type { BigCommerceOrder } from "../bigcommerce/sync";
import type { Env } from "../index";
import { PAID_BIGCOMMERCE_STATUSES } from "../lib/membershipOrders";
import { emailCardTo, findCardRecipient } from "./card";

const CUTOFF_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The cutoff as epoch ms, or null when unset or unusable (sending stays off). */
function cutoffMs(since: string | undefined): number | null {
  const value = since?.trim();
  if (!value) {
    return null;
  }
  const parsed = CUTOFF_SHAPE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed)) {
    console.error("New-order card email: CARD_EMAIL_NEW_ORDERS_SINCE is not a YYYY-MM-DD date, not sending", {
      value,
    });
    return null;
  }
  return parsed;
}

/**
 * Emails the member their card for a new paid order, once. Returns
 * whether a message was sent. Never throws: an order that syncs fine must not
 * fail its queue message over an email.
 */
export async function maybeEmailNewOrderCard(
  env: Env,
  order: BigCommerceOrder,
  memberEmail: string,
): Promise<boolean> {
  const since = cutoffMs(env.CARD_EMAIL_NEW_ORDERS_SINCE);
  if (since === null) {
    return false;
  }
  if (!PAID_BIGCOMMERCE_STATUSES.includes(order.status?.toLowerCase() ?? "")) {
    return false;
  }
  const createdMs = Date.parse(order.date_created);
  // NaN fails both comparisons, so an unparseable date can't slip past the
  // cutoff -- but say so, since every other order on that store parses.
  if (Number.isNaN(createdMs)) {
    console.error("New-order card email: could not read the order's creation date, not sending", {
      orderId: order.id,
      dateCreated: order.date_created,
    });
    return false;
  }
  if (createdMs < since) {
    console.info("New-order card email: order predates CARD_EMAIL_NEW_ORDERS_SINCE, not sending", {
      orderId: order.id,
    });
    return false;
  }
  // Eligibility before the claim: an environment with the cutoff set but no
  // email binding would otherwise burn each order's one chance.
  const member = await findCardRecipient(env, memberEmail);
  if (!member) {
    return false;
  }
  // Claims the send. A row already here means another delivery got there
  // first, whether or not it managed to deliver: one email per order, and a
  // member who never received it can still use /email-card.
  const claimed = await env.DB.prepare(
    `INSERT INTO card_emails (order_id, member_email) VALUES (?, ?)
     ON CONFLICT(order_id) DO NOTHING
     RETURNING order_id`,
  )
    .bind(bigCommerceOrderKey(order.id), member.email)
    .first<{ order_id: string }>();
  if (!claimed) {
    return false;
  }
  return emailCardTo(env, member, { kind: "new-order" });
}
