/**
 * Expelling somebody from the group, and lifting that again (#31).
 *
 * A ban is the heavier of the two things an admin can do to a person here,
 * and the difference from a revoked card is worth keeping straight:
 *
 * - **A revoked card** stops the card working. They can still sign in and
 *   still exist here.
 * - **A ban** also stops them signing in at all, takes effect on sessions
 *   they already hold, and revokes whatever membership they have.
 *
 * The membership half is not written down anywhere. `MEMBER_SELECT` resolves
 * a ban into the same `revoked` status a revoked card produces, so lifting
 * a ban restores the membership by itself, and somebody who is both banned
 * and separately revoked stays revoked when the ban is lifted.
 *
 * Indefinite on purpose. In practice these run a couple of years, but a date
 * that expired on its own would put a person back in without anybody
 * deciding they should be -- which is the Membership Committee's decision to
 * make and not software's to make for them.
 */

import type { Env } from "../index";
import { actorEmail, recordAuditEvent } from "../audit/log";
import { getMemberByEmail } from "./artifacts";
import { notifyWalletsUpdated } from "./walletUpdates";

/** Long enough to explain a decision, short enough to stay a note. */
export const MAX_BAN_NOTE_LENGTH = 500;

export interface BannedPerson {
  email: string;
  note: string | null;
  banned_by_email: string | null;
  banned_at: number;
  /** Whether they hold a membership this ban is currently suppressing. */
  has_membership: number;
}

/** Whether this address is expelled. Read on every authenticated request. */
export async function isBanned(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM banned_people WHERE email = ?",
  )
    .bind(email.trim().toLowerCase())
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Whether the person this session belongs to is expelled.
 *
 * By user id rather than address, because that is what a session carries.
 * One indexed lookup, on every authenticated request: a ban that only took
 * effect at the next sign-in would leave somebody inside for as long as
 * their session lasted, which is the opposite of what a ban is for.
 */
export async function isUserBanned(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present
       FROM users u JOIN banned_people b ON b.email = lower(u.email)
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{ present: number }>();
  return row !== null;
}

export async function banPerson(
  env: Env,
  email: string,
  note: string | null,
  bannedBy: number | null,
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const result = await env.DB.prepare(
    `INSERT INTO banned_people (email, note, banned_by)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(key, note, bannedBy)
    .run();
  // Already expelled: leave the original note, author and date alone rather
  // than restamping somebody else's decision.
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "person.expelled",
    subjectEmail: key,
    actorEmail: await actorEmail(env, bannedBy),
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
export async function liftBan(
  env: Env,
  email: string,
  liftedBy: number | null = null,
): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const result = await env.DB.prepare("DELETE FROM banned_people WHERE email = ?")
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
 * against, and without it the one place a ban would not reach is the passes
 * already installed on the phone of the person being expelled.
 *
 * Harmless when there is no membership. Somebody can be expelled before they
 * have ever bought anything, and the ban applies if they later do.
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
export async function bannedPeople(env: Env): Promise<BannedPerson[]> {
  const { results } = await env.DB.prepare(
    `SELECT b.email, b.note, u.email AS banned_by_email, b.banned_at,
            EXISTS (SELECT 1 FROM members m WHERE m.email = b.email) AS has_membership
       FROM banned_people b
            LEFT JOIN users u ON u.id = b.banned_by
      ORDER BY b.banned_at DESC`,
  ).all<BannedPerson>();
  return results;
}
