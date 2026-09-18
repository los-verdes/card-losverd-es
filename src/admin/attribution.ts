/**
 * Attributing a membership order to someone other than its purchaser
 * (los-verdes/card-losverd-es#70): a gift, or a member whose current email
 * differs from the one on an old order. The attribution is
 * `membership_orders.member_email`, which the BigCommerce sync never
 * overwrites; every change is also appended to
 * `membership_order_attributions`. Cards are derived from `member_email`
 * (src/bigcommerce/sync.ts `refreshMemberFromOrders`), so both the previous
 * and the new member are re-derived afterwards.
 */

import {
  MEMBERSHIP_SKU_TIER_MAP,
  refreshMemberFromOrders,
  type MemberUpsertResult,
} from "../bigcommerce/sync";
import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";
import { notifyWalletsUpdated } from "../member/walletUpdates";

export interface AttributableOrder {
  order_id: string;
  source: string;
  order_email: string;
  member_email: string;
  first_name: string | null;
  last_name: string | null;
  sku: string | null;
  status: string | null;
  created_on: string;
  expires_on: string;
  /**
   * Whether the order counts as a membership (not voided or a test order).
   *
   * SQLite's 0/1 -- or **NULL**, for a row whose status is NULL, because
   * `lower(NULL) IN (...)` is NULL rather than false. That is the right
   * answer (a statusless BigCommerce order does not count) and it reads
   * correctly as falsy, but it is not 0: compare truthily, never `=== 0`.
   */
  counts: number | null;
  /** When BigCommerce stopped returning this order, if it has (#105). */
  missing_since: number | null;
}

export async function getAttributableOrder(
  db: D1Database,
  orderId: string,
): Promise<AttributableOrder | null> {
  return db
    .prepare(
      `SELECT order_id, source, order_email, member_email, first_name, last_name, sku, status,
              created_on, expires_on, missing_since, (${COUNTS_AS_MEMBERSHIP}) AS counts
       FROM membership_orders WHERE order_id = ?`,
    )
    .bind(orderId)
    .first<AttributableOrder>();
}

export interface AttributionRecord {
  previous_member_email: string;
  member_email: string;
  admin_email: string | null;
  note: string | null;
  created_at: number;
}

/** An order's attribution history, newest first. */
export async function listAttributions(
  db: D1Database,
  orderId: string,
): Promise<AttributionRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT a.previous_member_email, a.member_email, u.email AS admin_email, a.note, a.created_at
       FROM membership_order_attributions a LEFT JOIN users u ON u.id = a.admin_user_id
       WHERE a.order_id = ? ORDER BY a.id DESC`,
    )
    .bind(orderId)
    .all<AttributionRecord>();
  return results;
}

/**
 * Everywhere an email address already appears, so an admin can sanity-check
 * the address they typed before attributing an order to it.
 */
export interface EmailFootprint {
  member: { member_id: string; status: string; expiration_date: string | null } | null;
  /** Orders attributed to the address, and how many of those count as memberships. */
  memberOrders: { total: number; counted: number };
  /** Orders placed with the address, whoever they're attributed to now. */
  placedOrders: number;
  login: { is_admin: number } | null;
  slack: { slack_id: string; name: string | null; deleted: number } | null;
}

export async function emailFootprint(
  db: D1Database,
  email: string,
): Promise<EmailFootprint> {
  const [member, memberOrders, placedOrders, login, slack] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT member_id, status, expiration_date FROM members WHERE email = ?1").bind(email),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(${COUNTS_AS_MEMBERSHIP}), 0) AS counted
         FROM membership_orders WHERE member_email = ?1`,
      )
      .bind(email),
    db.prepare("SELECT COUNT(*) AS total FROM membership_orders WHERE order_email = ?1").bind(email),
    db.prepare("SELECT is_admin FROM users WHERE email = ?1").bind(email),
    db.prepare("SELECT slack_id, name, deleted FROM slack_users WHERE lower(email) = ?1 ORDER BY deleted, slack_id LIMIT 1").bind(email),
  ]);
  const first = <T>(result: D1Result<Record<string, unknown>>) => (result.results[0] as T | undefined) ?? null;
  return {
    member: first(member),
    memberOrders: first<{ total: number; counted: number }>(memberOrders)!,
    placedOrders: first<{ total: number }>(placedOrders)!.total,
    login: first(login),
    slack: first(slack),
  };
}

export interface AttributionResult {
  previousMemberEmail: string;
  /** The previous member's re-derived card (null if they have no member row). */
  previous: MemberUpsertResult | null;
  /** The new member's card (null if the order doesn't count, so no card was created). */
  current: MemberUpsertResult | null;
}

/**
 * Re-points `order` at `memberEmail` (already lowercased and validated), logs
 * it, re-derives both members' cards, and pushes pass updates for any card
 * that changed.
 */
export async function attributeOrder(
  env: Env,
  order: AttributableOrder,
  memberEmail: string,
  adminUserId: number,
  note: string | null,
): Promise<AttributionResult> {
  const previousMemberEmail = order.member_email;
  await env.DB.batch([
    env.DB.prepare("UPDATE membership_orders SET member_email = ?, updated_at = unixepoch('subsec') * 1000 WHERE order_id = ?").bind(
      memberEmail,
      order.order_id,
    ),
    env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(order.order_id, previousMemberEmail, memberEmail, adminUserId, note),
  ]);

  // Only needed for a brand-new member whose order history doesn't say
  // (e.g. a Squarespace-era order with no name); see MemberFallback.
  const fallback = {
    firstName: order.first_name ?? "",
    lastName: order.last_name ?? "",
    membershipTier: (order.sku && MEMBERSHIP_SKU_TIER_MAP[order.sku]) || "standard",
  };
  const previous = await refreshMemberFromOrders(env, previousMemberEmail, fallback);
  const current = await refreshMemberFromOrders(env, memberEmail, fallback);
  for (const result of [previous, current]) {
    if (result?.passChanged) await notifyWalletsUpdated(env, result.memberId);
  }
  return { previousMemberEmail, previous, current };
}
