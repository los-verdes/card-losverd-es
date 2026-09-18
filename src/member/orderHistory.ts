/**
 * A member's own membership order history, for the card page.
 *
 * Ported from the legacy app's "Membership History" panel
 * (`macros.html.j2`), which listed every order it held for the signed-in
 * member. Two deliberate differences: that panel dumped each order's every
 * field, where this shows the ones a member can act on; and it said nothing
 * about whether an order counted, which is exactly the question someone asks
 * when the card says their membership has expired.
 */

import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";

export interface MemberOrder {
  order_id: string;
  product_name: string | null;
  status: string | null;
  created_on: string;
  expires_on: string;
  /** D1 returns SQLite's 0/1 for the shared counting rule. */
  counts: number;
}

/**
 * Every order attributed to this member, newest first -- including the ones
 * that do not count. A refunded order explains an expired membership, and
 * hiding it would leave the member with no way to see why.
 *
 * Keyed on `member_email`, the same column memberships are derived from, so a
 * gift shows up on the recipient's history rather than the purchaser's
 * (`src/admin/attribution.ts`).
 */
export async function getMemberOrderHistory(
  env: Env,
  memberEmail: string,
): Promise<MemberOrder[]> {
  const { results } = await env.DB.prepare(
    `SELECT order_id, product_name, status, created_on, expires_on,
            (${COUNTS_AS_MEMBERSHIP}) AS counts
     FROM membership_orders
     WHERE member_email = ?
     ORDER BY created_on DESC, order_id DESC`,
  )
    .bind(memberEmail.toLowerCase())
    .all<MemberOrder>();
  return results;
}

/**
 * The number a member would recognise from their receipt. Order ids carry a
 * source suffix (`104_bc`); the legacy app showed the part before it, so a
 * member comparing the two sees the same number.
 */
export function displayOrderNumber(orderId: string): string {
  return orderId.split("_")[0];
}
