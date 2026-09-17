/**
 * Emailing a member their card when a new membership order is completed
 * (los-verdes/card-losverd-es#70), so a new member never has to visit the
 * site at all.
 *
 * The danger this file is built around: emailing cards must never happen in
 * bulk. A backfill, a scheduled resync, the legacy Postgres import or cutover
 * would otherwise mail hundreds of existing members at once. Three guards,
 * each sufficient on its own:
 *
 * 1. **Webhook path only.** This is called from `syncBigCommerceOrder`, the
 *    path a BigCommerce order webhook takes. The scheduled resync and
 *    `loadAll` full resync go through `applyMembershipOrder` directly and
 *    never reach here; the legacy import writes D1 without running any of it.
 * 2. **A cutoff date.** `CARD_EMAIL_NEW_ORDERS_SINCE` (a plain var, empty by
 *    default) switches sending on. Only orders created on or after it are
 *    eligible, so replaying or re-syncing older orders can't send anything.
 * 3. **A sent log.** `card_emails` (migration 0010) is written *before* the
 *    send and claims the order, so a webhook retry or duplicate delivery
 *    can't send a second copy.
 *
 * On top of those, an order only qualifies as it *becomes* `Completed`: the
 * agreed rule (2026-09-17) is to wait until the membership pack is on its
 * way, and to send at most one email per order.
 */

import type { BigCommerceOrder } from "../bigcommerce/sync";
import { bigCommerceOrderKey } from "../bigcommerce/orders";
import type { Env } from "../index";
import { emailMemberCard } from "./card";

const COMPLETED = "completed";

/**
 * Emails the member their card if this sync is the moment `order` became
 * `Completed`. `previousStatus` is the status D1 held before this sync (null
 * for an order seen for the first time). Returns whether a message was sent.
 */
export async function maybeEmailNewOrderCard(
  env: Env,
  order: BigCommerceOrder,
  previousStatus: string | null,
  memberEmail: string,
): Promise<boolean> {
  const since = env.CARD_EMAIL_NEW_ORDERS_SINCE?.trim();
  if (!since) {
    return false;
  }
  if (order.status?.toLowerCase() !== COMPLETED) {
    return false;
  }
  // Already completed before this sync: this is a re-delivery, not the
  // transition.
  if (previousStatus?.toLowerCase() === COMPLETED) {
    return false;
  }
  if (new Date(order.date_created).toISOString().slice(0, 10) < since) {
    console.info("New-order card email: order predates CARD_EMAIL_NEW_ORDERS_SINCE, not sending", {
      orderId: order.id,
      since,
    });
    return false;
  }
  // Claims the send. A row already here means someone (or a retry) got there
  // first, whether or not that attempt managed to deliver: one email per
  // order, and a member who never received it can use /email-card.
  const claimed = await env.DB.prepare(
    `INSERT INTO card_emails (order_id, member_email) VALUES (?, ?)
     ON CONFLICT(order_id) DO NOTHING
     RETURNING order_id`,
  )
    .bind(bigCommerceOrderKey(order.id), memberEmail)
    .first<{ order_id: string }>();
  if (!claimed) {
    return false;
  }
  return emailMemberCard(env, memberEmail, { kind: "new-order" });
}
