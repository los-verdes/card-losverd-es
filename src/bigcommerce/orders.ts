/**
 * Writes BigCommerce membership orders into `membership_orders`, the
 * comprehensive order history behind admin reporting (migration 0008).
 * `members` only holds each member's current state; this is the per-order
 * record, a port of the legacy app's `annual_membership` table.
 */

import type { Env } from "../index";
import type { BigCommerceOrder, BigCommerceOrderProduct } from "./sync";

export const MEMBERSHIP_DURATION_DAYS = 365;

/** `YYYY-MM-DDTHH:MM:SSZ` (UTC, no milliseconds) -- the table's timestamp format. */
export function toIsoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Mirrors the legacy `AnnualMembership.expiry_date`: `created_on` + 365 days. */
export function membershipExpiry(createdOn: Date): Date {
  return new Date(
    createdOn.getTime() + MEMBERSHIP_DURATION_DAYS * 24 * 60 * 60 * 1000,
  );
}

/**
 * An order's key: BigCommerce's own order id, as the store reports it.
 *
 * The previous site appended `_bc`, against a worry that a BigCommerce id and
 * a Squarespace one might collide while both stores were in use. They cannot:
 * a Squarespace id is 24 hexadecimal characters and a BigCommerce one a short
 * integer, and `membership_orders.source` records which store an order came
 * from regardless. So the key is the id the Merch Team sees in the store's
 * admin, and the legacy export strips the suffix to match.
 *
 * Kept as a function, rather than inlined, because the export and this sync
 * have to agree on it -- an imported order and a synced one must be the same
 * row, not two.
 */
export function bigCommerceOrderKey(orderId: number | string): string {
  return String(orderId);
}

/**
 * Idempotent upsert of one membership order. Everything the store reports is
 * refreshed on every sync (status changes such as refunds must land), except:
 * - `member_email`, which may have been re-pointed at the member's current
 *   address (by the legacy import today) and must survive a resync;
 * - `first_seen_via`, which records provenance.
 *
 * Returns the row's `member_email`: the member this order belongs to.
 */
export async function recordMembershipOrder(
  env: Env,
  order: BigCommerceOrder,
  product: BigCommerceOrderProduct,
  membershipUnits: number,
): Promise<string> {
  const createdOn = new Date(order.date_created);
  const email = order.billing_address.email.trim().toLowerCase();
  const row = await env.DB.prepare(
    `INSERT INTO membership_orders (
       order_id, source, order_number, channel_name, order_email, member_email,
       first_name, last_name, customer_id, sku, product_name, status,
       created_on, expires_on, modified_on, membership_units, first_seen_via
     ) VALUES (?1, 'bigcommerce', ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'sync')
     ON CONFLICT(order_id) DO UPDATE SET
       order_number = excluded.order_number,
       channel_name = excluded.channel_name,
       order_email = excluded.order_email,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       customer_id = excluded.customer_id,
       sku = excluded.sku,
       product_name = excluded.product_name,
       status = excluded.status,
       created_on = excluded.created_on,
       expires_on = excluded.expires_on,
       modified_on = excluded.modified_on,
       -- Recounted from the store's line items every sync, so an order
       -- corrected in BigCommerce stops being flagged (#188) the same way a
       -- transient 404 heals itself below.
       membership_units = excluded.membership_units,
       -- BigCommerce returned it, so whatever made it look missing is over
       -- (#105). A transient 404 therefore heals itself on the next sync.
       -- Deliberately absent from this list: member_email. It is the only
       -- record of a membership the legacy app transferred (its
       -- add-memberships-to-user-email command repointed the order at another
       -- user and left customer_email alone), and of any order an admin has
       -- since attributed (#70). The store has no opinion on either, so the
       -- store's copy must not win. test/bigcommerce/orders.spec.ts pins this.
       missing_since = NULL,
       updated_at = unixepoch('subsec') * 1000
     RETURNING member_email`,
  )
    .bind(
      bigCommerceOrderKey(order.id),
      `${order.id}_${order.cart_id ?? "None"}`, // "None": what the legacy app stored for a missing cart id
      order.order_source ? `bigcommerce_${order.order_source}` : null,
      email,
      order.billing_address.first_name,
      order.billing_address.last_name,
      order.customer_id,
      product.sku,
      product.name,
      order.status,
      toIsoSeconds(createdOn),
      toIsoSeconds(membershipExpiry(createdOn)),
      order.date_modified ? toIsoSeconds(new Date(order.date_modified)) : null,
      membershipUnits,
    )
    .first<{ member_email: string }>();
  return row!.member_email;
}
