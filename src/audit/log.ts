/**
 * Writing and reading the audit log (migration 0020).
 *
 * Every function that changes somebody's standing, name or "member since"
 * calls `recordAuditEvent` as part of doing so. The tables those functions
 * write hold the current state and lose the previous one; this keeps the
 * sequence.
 *
 * Two rules the callers depend on:
 *
 * 1. **The detail line is composed by the caller**, not assembled from
 *    columns when the page renders. A log whose meaning shifts when the code
 *    around it is refactored is not a log, and the caller is the only place
 *    that still knows what the old value was.
 * 2. **The actor is stored as an address, not a user id.** A `users` row can
 *    be deleted, and a foreign key with `ON DELETE SET NULL` would quietly
 *    erase exactly the fact this table exists to keep.
 */

import type { Env } from "../index";

export interface AuditEvent {
  /** Coarse verb: what was decided, not which table moved. */
  action: AuditAction;
  /** The person it was about. Null only where there is genuinely nobody. */
  subjectEmail: string | null;
  /** Who did it, or null for something the software did on its own. */
  actorEmail: string | null;
  /** One line, readable on its own, already carrying the old value if any. */
  detail: string;
}

/**
 * The vocabulary. Kept to a closed set so the log can be filtered and read at
 * a glance, and so adding a new kind of event is a deliberate act rather than
 * a new string appearing in the column.
 *
 * Named after the decision in the words the group uses for it -- the code of
 * conduct's "revoke" and "expel" rather than this codebase's older
 * `banned_people` -- because these lines are read by people, not by the code.
 */
export const AUDIT_ACTIONS = [
  "membership.revoked",
  "membership.restored",
  "person.expelled",
  "person.readmitted",
  "display_name.set",
  "display_name.cleared",
  "member_since.set",
  "member_since.cleared",
  "order.reattributed",
  "card.emailed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** How each action reads on the page, so the stored verb never has to. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "membership.revoked": "Membership revoked",
  "membership.restored": "Membership restored",
  "person.expelled": "Expelled from the group",
  "person.readmitted": "Expulsion lifted",
  "display_name.set": "Card name set",
  "display_name.cleared": "Card name cleared",
  "member_since.set": "Member since corrected",
  "member_since.cleared": "Member since correction removed",
  "order.reattributed": "Order re-attributed",
  "card.emailed": "Card emailed",
};

/**
 * Records one event. Throws if it cannot, on purpose: for everything except a
 * send that has already left, a silent gap in this log is worse than the
 * caller failing and being retried.
 */
export async function recordAuditEvent(env: Env, event: AuditEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (action, subject_email, actor_email, detail)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(
      event.action,
      event.subjectEmail?.trim().toLowerCase() ?? null,
      event.actorEmail?.trim().toLowerCase() ?? null,
      event.detail,
    )
    .run();
}

/**
 * The same, for a side effect that has already happened and cannot be undone
 * by failing here -- an email that has left the building. Losing the line is
 * bad; throwing out of a send that succeeded is worse, because the caller's
 * only remaining move is to send it again.
 */
export async function recordAuditEventBestEffort(
  env: Env,
  event: AuditEvent,
): Promise<void> {
  try {
    await recordAuditEvent(env, event);
  } catch (error) {
    console.error("audit: could not record an event that already happened", {
      action: event.action,
      error: String(error),
    });
  }
}

export interface AuditEntry {
  id: number;
  action: AuditAction;
  subject_email: string | null;
  actor_email: string | null;
  detail: string;
  created_at: number;
}

/**
 * Most recent first. `email` narrows it to one person's history, which is the
 * question asked from their own admin page.
 */
export async function readAuditLog(
  env: Env,
  options: { email?: string | null; limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const email = options.email?.trim().toLowerCase();
  const { results } = email
    ? await env.DB.prepare(
        `SELECT id, action, subject_email, actor_email, detail, created_at
           FROM audit_log WHERE subject_email = ? ORDER BY id DESC LIMIT ?`,
      )
        .bind(email, limit)
        .all<AuditEntry>()
    : await env.DB.prepare(
        `SELECT id, action, subject_email, actor_email, detail, created_at
           FROM audit_log ORDER BY id DESC LIMIT ?`,
      )
        .bind(limit)
        .all<AuditEntry>();
  return results;
}

/**
 * The address to record as the actor, for a signed-in user id.
 *
 * Resolved at write time rather than stored as an id, and looked up per
 * action rather than carried on the session: the session predates any change
 * to the row, and an address that has since changed would be the wrong answer
 * to "who did this" only if it were read later, which it never is.
 */
export async function actorEmail(env: Env, userId: number | null): Promise<string | null> {
  if (userId === null) return null;
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  return row?.email ?? null;
}
