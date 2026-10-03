/**
 * Store accounts connected to card-site users (#38).
 *
 * A store customer is linked to a user only when one browser has proved both
 * at once: a verified storefront `current.jwt` (src/bigcommerce/appJwt.ts)
 * and a Google or Apple sign-in here (src/bigcommerce/storeHandoff.tsx). After
 * that, `users.bigcommerce_id` is the only thing read in either direction.
 * Orders are never used to decide who someone is: an order's `customer_id`
 * says who paid, which for a gift is somebody else.
 */

import { actorEmail, recordAuditEvent } from "../audit/log";
import type { Env } from "../index";

/** A store account already connected to somebody else. It is refused, not moved: an admin can disconnect it first. */
export class StoreAccountTaken extends Error {}

export interface StoreAccountLink {
  customerId: number;
  linkedAt: number | null;
  /**
   * The store account's email, as the store last stated it, for showing back
   * to its holder. Null until the store has said (a connection made before it
   * was kept). Never matched against anything.
   */
  email: string | null;
}

/** The store account connected to this user, if any. */
export async function storeAccountFor(env: Env, userId: number): Promise<StoreAccountLink | null> {
  const row = await env.DB.prepare("SELECT bigcommerce_id, bigcommerce_linked_at, bigcommerce_email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ bigcommerce_id: number | null; bigcommerce_linked_at: number | null; bigcommerce_email: string | null }>();
  return row?.bigcommerce_id
    ? { customerId: row.bigcommerce_id, linkedAt: row.bigcommerce_linked_at, email: row.bigcommerce_email }
    : null;
}

/**
 * Keeps the email shown for a connected store account up to date, from the
 * store's own verified token. Only ever displayed; a missing email leaves the
 * last one in place.
 */
export async function rememberStoreEmail(env: Env, customerId: number, email: string | null): Promise<void> {
  if (!email) return;
  await env.DB.prepare("UPDATE users SET bigcommerce_email = ? WHERE bigcommerce_id = ?").bind(email, customerId).run();
}

/** The user a store customer is connected to, if any. */
export async function userForStoreCustomer(
  env: Env,
  customerId: number,
): Promise<{ id: number; email: string; is_admin: number } | null> {
  return env.DB.prepare("SELECT id, email, is_admin FROM users WHERE bigcommerce_id = ?")
    .bind(customerId)
    .first<{ id: number; email: string; is_admin: number }>();
}

async function emailOf(env: Env, userId: number): Promise<string | null> {
  return (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>())?.email ?? null;
}

/**
 * Connects a store account to a user, replacing any they had before.
 * Refuses one connected to somebody else. `byUserId` is who did it: the
 * member themselves, as a rule.
 */
export async function linkStoreAccount(
  env: Env,
  userId: number,
  customerId: number,
  byUserId: number,
  email: string | null = null,
): Promise<void> {
  const holder = await userForStoreCustomer(env, customerId);
  if (holder && holder.id !== userId) throw new StoreAccountTaken(`store customer ${customerId} is connected to another user`);
  const previous = await storeAccountFor(env, userId);
  if (previous?.customerId === customerId) return rememberStoreEmail(env, customerId, email);
  await env.DB.prepare(
    "UPDATE users SET bigcommerce_id = ?, bigcommerce_linked_at = unixepoch('subsec') * 1000, bigcommerce_email = ? WHERE id = ?",
  )
    .bind(customerId, email, userId)
    .run();
  await recordAuditEvent(env, {
    action: "store_account.linked",
    subjectEmail: await emailOf(env, userId),
    actorEmail: await actorEmail(env, byUserId),
    detail: `Store customer ${customerId}` + (previous ? ` (was ${previous.customerId})` : ""),
  });
}

/** Disconnects this user's store account, if they have one. Returns whether there was one. */
export async function unlinkStoreAccount(env: Env, userId: number, byUserId: number): Promise<boolean> {
  const previous = await storeAccountFor(env, userId);
  if (!previous) return false;
  await env.DB.prepare("UPDATE users SET bigcommerce_id = NULL, bigcommerce_linked_at = NULL, bigcommerce_email = NULL WHERE id = ?")
    .bind(userId)
    .run();
  await recordAuditEvent(env, {
    action: "store_account.unlinked",
    subjectEmail: await emailOf(env, userId),
    actorEmail: await actorEmail(env, byUserId),
    detail: `Store customer ${previous.customerId}`,
  });
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface HandoffClaim {
  /** Whether this was the token's first use. */
  claimed: boolean;
  /** The token's SHA-256, which is how it is referred to after this. */
  tokenHash: string;
}

/**
 * Accepts a storefront token for a handoff once. It is a bearer token for its
 * lifetime, so a copy of one (from a log, a proxy, a shared machine) must not
 * sign anyone in again. Only its SHA-256 is kept, until it would have
 * expired, along with the SHA-256 of the marker given to the browser that
 * used it first (`handoffTokenHeldBy`).
 */
export async function claimHandoffToken(
  env: Env,
  token: string,
  expiresAtSeconds: number,
  browserMarker: string,
): Promise<HandoffClaim> {
  const now = Date.now();
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM store_handoff_tokens WHERE expires_at < ?").bind(now).run();
  const result = await env.DB.prepare(
    "INSERT INTO store_handoff_tokens (token_hash, expires_at, browser_hash) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO NOTHING",
  )
    .bind(tokenHash, expiresAtSeconds * 1000, await sha256Hex(browserMarker))
    .run();
  return { claimed: (result.meta.changes ?? 0) > 0, tokenHash };
}

/**
 * Whether a spent token was spent by the browser holding this marker, and is
 * still in date. The store reuses one token for 15 minutes, so the same member
 * coming back inside that time presents it again; anyone else presenting it
 * holds a copy.
 */
export async function handoffTokenHeldBy(env: Env, tokenHash: string, browserMarker: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT browser_hash FROM store_handoff_tokens WHERE token_hash = ? AND expires_at >= ?")
    .bind(tokenHash, Date.now())
    .first<{ browser_hash: string | null }>();
  return row?.browser_hash != null && row.browser_hash === (await sha256Hex(browserMarker));
}
