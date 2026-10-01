/**
 * Refreshing every installed pass at once (#333), for a change that alters
 * cards without changing any member: switching on year themes by default,
 * or Apple's poster layout. Each refreshed member gets exactly what any
 * other pass-visible change gets -- `last_updated_at` bumped, then
 * `notifyWalletsUpdated()` -- and nothing more. It never emails anyone.
 *
 * Run deliberately (`just etl-run <env> refresh-passes-admins`, then
 * `refresh-passes`), never on a schedule: it is a push to many devices.
 *
 * - **Only members who could have a pass installed**: an Apple device
 *   registered for theirs, a sign-in here (a Google pass is created when a
 *   save link is built, which takes one), or a card emailed to them (whose
 *   email carries the save links). Anyone else has nothing to refresh, and
 *   asking Google about them would only be told so.
 * - **In stages, by audience**: admins' own cards first, then everyone, so
 *   anyone unhappy with a change can say so before everyone has it.
 * - **Once per run**: a run is named by when it started, carried on every
 *   message, and a member already refreshed since then is skipped, so a
 *   message delivered twice changes nothing.
 *
 * Revoked and expelled members are left out: their passes were refreshed
 * when that was decided.
 */

import type { Env } from "../index";
import { notifyWalletsUpdated } from "./walletUpdates";

/** Members per message; each costs a few D1 queries, an Apple push per registered device, and one Google call. */
export const PASS_REFRESH_BATCH = 50;

export type PassRefreshAudience = "admins" | "everyone";

export interface PassRefreshCursor {
  audience: PassRefreshAudience;
  /** When the run began (epoch ms): members refreshed since are skipped. */
  startedAt: number;
  /** The last member refreshed; the next batch starts after it. */
  afterMemberId: string;
  /** Members refreshed by the run's earlier messages. */
  refreshed: number;
}

/** A member who could hold an installed pass, of the given audience, not refreshed since the run began. */
const TARGETS_SQL = `
  SELECT m.member_id
    FROM members m
   WHERE m.member_id > ?1
     AND m.last_updated_at < ?2
     AND NOT EXISTS (SELECT 1 FROM revoked_cards r WHERE r.member_id = m.member_id)
     AND NOT EXISTS (SELECT 1 FROM expelled_people e WHERE e.email = m.email)
     AND (
       EXISTS (SELECT 1 FROM registrations g WHERE g.serial_number = m.member_id)
       OR EXISTS (SELECT 1 FROM users u WHERE u.email = m.email OR u.id = m.user_id)
       OR EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'card.emailed' AND a.subject_email = m.email)
     )
     AND (?3 = 'everyone' OR EXISTS (
       SELECT 1 FROM users u WHERE u.is_admin = 1 AND (u.email = m.email OR u.id = m.user_id)
     ))
   ORDER BY m.member_id
   LIMIT ?4`;

/** One batch of a run; returns the cursor for the next, or null once the run is done. */
export async function refreshInstalledPasses(
  env: Env,
  cursor: Partial<PassRefreshCursor> & { audience: PassRefreshAudience },
): Promise<PassRefreshCursor | null> {
  const run: PassRefreshCursor = {
    audience: cursor.audience,
    startedAt: cursor.startedAt ?? Date.now(),
    afterMemberId: cursor.afterMemberId ?? "",
    refreshed: cursor.refreshed ?? 0,
  };
  const { results } = await env.DB.prepare(TARGETS_SQL)
    .bind(run.afterMemberId, run.startedAt, run.audience, PASS_REFRESH_BATCH)
    .all<{ member_id: string }>();

  for (const { member_id } of results) {
    await env.DB.prepare("UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE member_id = ?")
      .bind(member_id)
      .run();
    await notifyWalletsUpdated(env, member_id);
  }

  const refreshed = run.refreshed + results.length;
  if (results.length === PASS_REFRESH_BATCH) {
    return { ...run, afterMemberId: results[results.length - 1].member_id, refreshed };
  }
  console.log("installed pass refresh complete", { audience: run.audience, refreshed, startedAt: run.startedAt });
  return null;
}
