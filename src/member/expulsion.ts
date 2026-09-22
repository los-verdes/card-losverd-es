/**
 * Expelling somebody from the group, and lifting that again (#31). Rare.
 *
 * Unlike a revoked card, an expulsion also stops the person signing in,
 * including on sessions they already hold. `MEMBER_SELECT` resolves it into
 * the same `revoked` status a revoked card produces, so lifting it restores
 * the membership by itself. Indefinite: only a person lifts it.
 */

import type { Env } from "../index";
import { actorEmail, recordAuditEvent } from "../audit/log";
import { getMemberByEmail } from "./artifacts";
import { notifyWalletsUpdated } from "./walletUpdates";

/** Long enough to explain a decision, short enough to stay a note. */
export const MAX_EXPULSION_NOTE_LENGTH = 500;

export interface ExpelledPerson {
  email: string;
  note: string | null;
  expelled_by_email: string | null;
  expelled_at: number;
  /** Whether they hold a membership this expulsion is currently suppressing. */
  has_membership: number;
}

/** Whether this address is expelled. Read on every authenticated request. */
export async function isExpelled(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM expelled_people WHERE email = ?",
  )
    .bind(email.trim().toLowerCase())
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Whether the person this session belongs to is expelled.
 *
 * By user id rather than address, because that is what a session carries.
 * One indexed lookup, on every authenticated request: an expulsion that only took
 * effect at the next sign-in would leave somebody inside for as long as
 * their session lasted, which is the opposite of what an expulsion is for.
 */
export async function isUserExpelled(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present
       FROM users u JOIN expelled_people b ON b.email = lower(u.email)
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{ present: number }>();
  return row !== null;
}

export async function expelPerson(
  env: Env,
  email: string,
  note: string | null,
  expelledBy: number | null,
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const result = await env.DB.prepare(
    `INSERT INTO expelled_people (email, note, expelled_by)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(key, note, expelledBy)
    .run();
  // Already expelled: leave the original note, author and date alone rather
  // than restamping somebody else's decision.
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "person.expelled",
    subjectEmail: key,
    actorEmail: await actorEmail(env, expelledBy),
    detail: note ? note : "No reason recorded",
  });
  await touchAndNotify(env, key);
  return true;
}

/**
 * Lifts an expulsion. Any membership it was suppressing comes back by itself.
 *
 * `liftedBy` goes to the audit log rather than into a column: the row is
 * deleted, so that entry is the only surviving account of the reversal --
 * and an appeal is precisely when somebody asks who decided it.
 */
export async function readmitPerson(
  env: Env,
  email: string,
  liftedBy: number | null = null,
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const result = await env.DB.prepare("DELETE FROM expelled_people WHERE email = ?")
    .bind(key)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "person.readmitted",
    subjectEmail: key,
    actorEmail: await actorEmail(env, liftedBy),
    detail: "Expulsion lifted; any membership it was suppressing is back.",
  });
  await touchAndNotify(env, key);
  return true;
}

/**
 * `members.last_updated_at` is bumped by hand, as everywhere else a fact
 * lives outside that table: it is what Apple's polling endpoint compares
 * against, and without it the one place an expulsion would not reach is the passes
 * already installed on the phone of the person being expelled.
 *
 * Harmless when there is no membership. Somebody can be expelled before they
 * have ever bought anything, and the expulsion applies if they later do.
 */
async function touchAndNotify(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE email = ?",
  )
    .bind(email)
    .run();
  const member = await getMemberByEmail(env, email);
  if (member) await notifyWalletsUpdated(env, member.member_id);
}

/** Everybody currently expelled, most recent first, with who decided it. */
export async function expelledPeople(env: Env): Promise<ExpelledPerson[]> {
  const { results } = await env.DB.prepare(
    `SELECT b.email, b.note, u.email AS expelled_by_email, b.expelled_at,
            EXISTS (SELECT 1 FROM members m WHERE m.email = b.email) AS has_membership
       FROM expelled_people b
            LEFT JOIN users u ON u.id = b.expelled_by
      ORDER BY b.expelled_at DESC`,
  ).all<ExpelledPerson>();
  return results;
}
