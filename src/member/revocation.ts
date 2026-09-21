/**
 * Withdrawing a membership before it expires, and lifting that again (#31,
 * migration 0016).
 *
 * The reading half of this costs almost nothing: `revoked` was already a
 * legal `members.status`, already excluded by the access checks, already
 * carried on the Apple pass and already mapped to Google's `INACTIVE`. All
 * that was missing was a way for it to arrive, which `MEMBER_SELECT`
 * resolves from this table. So the code here is only about writing it down
 * and making sure the passes already in people's phones hear about it.
 */

import type { Env } from "../index";
import { getMemberById } from "./artifacts";
import { actorEmail, recordAuditEvent } from "../audit/log";
import { notifyWalletsUpdated } from "./walletUpdates";

/** Long enough to explain a decision, short enough to stay a note. */
export const MAX_REVOCATION_NOTE_LENGTH = 500;

export interface RevokedCard {
  member_id: string;
  email: string;
  note: string | null;
  revoked_by_email: string | null;
  revoked_at: number;
}

/**
 * Withdraws the membership on one card.
 *
 * `members.last_updated_at` is bumped by hand, for the same reason the
 * display-name path does it: the fact lives outside `members`, and that
 * column is what Apple's polling endpoint compares against. Without it the
 * membership would read as withdrawn everywhere except on the passes already
 * installed, which are the ones somebody would be holding up at a gate.
 */
export async function revokeCard(
  env: Env,
  memberId: string,
  note: string | null,
  revokedBy: number | null,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO revoked_cards (member_id, note, revoked_by)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(member_id) DO NOTHING`,
  )
    .bind(memberId, note, revokedBy)
    .run();
  // Already revoked: leave the original note, author and date alone rather
  // than quietly restamping somebody else's decision.
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "membership.revoked",
    subjectEmail: (await getMemberById(env, memberId))?.email ?? null,
    actorEmail: await actorEmail(env, revokedBy),
    detail: `Card ${memberId}${note ? ` -- ${note}` : " -- no reason recorded"}`,
  });
  await touchAndNotify(env, memberId);
  return true;
}

/**
 * Lifts a revocation, putting the membership back to what the orders say.
 *
 * `restoredBy` is recorded in the audit log rather than anywhere here: the
 * row is deleted, so this is the only account of the reversal that survives
 * it -- which is exactly the moment somebody asks who decided.
 */
export async function restoreCard(
  env: Env,
  memberId: string,
  restoredBy: number | null = null,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM revoked_cards WHERE member_id = ?",
  )
    .bind(memberId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "membership.restored",
    subjectEmail: (await getMemberById(env, memberId))?.email ?? null,
    actorEmail: await actorEmail(env, restoredBy),
    detail: `Card ${memberId}`,
  });
  await touchAndNotify(env, memberId);
  return true;
}

async function touchAndNotify(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE member_id = ?",
  )
    .bind(memberId)
    .run();
  const member = await getMemberById(env, memberId);
  if (member) await notifyWalletsUpdated(env, member.member_id);
}

/** Whether this card is currently withdrawn. */
export async function isRevoked(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM revoked_cards WHERE member_id = ?",
  )
    .bind(memberId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Every withdrawal, most recent first, with who made it.
 *
 * Joined to `members` for the address rather than storing a copy: a
 * withdrawal follows the card, and the address on the membership can be
 * re-pointed afterwards without making this list wrong.
 */
export async function revokedCards(env: Env): Promise<RevokedCard[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.member_id, m.email, r.note, u.email AS revoked_by_email, r.revoked_at
       FROM revoked_cards r
            JOIN members m ON m.member_id = r.member_id
            LEFT JOIN users u ON u.id = r.revoked_by
      ORDER BY r.revoked_at DESC`,
  ).all<RevokedCard>();
  return results;
}
