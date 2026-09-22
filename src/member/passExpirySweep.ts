/**
 * Once a day, refresh the passes of members whose membership has just lapsed
 * (#295).
 *
 * The wallets expire a pass on the phone by themselves, from the expiry the
 * pass states (`expirationDate` on Apple's, `validTimeInterval` on Google's).
 * What they cannot do is rewrite the pass: the "Expired" status on the back
 * of the Apple pass and Google's `EXPIRED` state are worked out when a pass
 * is built. So each day, members whose expiry date has passed since the last
 * run get the same refresh any other pass-visible change gets --
 * `last_updated_at` bumped, `notifyWalletsUpdated()` -- and nothing more. It
 * never emails anyone.
 *
 * A watermark (`etl_sync_state`) records the last expiry date covered, so a
 * day the job did not run is caught up rather than skipped. On its very
 * first run it covers only yesterday: passes that lapsed before this existed
 * are a one-off refresh of their own, not something to push on a schedule.
 */

import type { Env } from "../index";
import { notifyWalletsUpdated } from "./walletUpdates";

export const PASS_EXPIRY_SWEEP_JOB = "pass_expiry_sweep";

/**
 * Per run. A day's lapses are a handful even in the renewal season; this is a
 * backstop. A run that hits it leaves the watermark short of its last date,
 * so tomorrow's run starts from there.
 */
export const MAX_MEMBERS_PER_SWEEP = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface PassExpirySweepResult {
  refreshed: number;
  /** The last expiry date now covered, `YYYY-MM-DD`. */
  coveredThrough: string;
}

export async function runPassExpirySweep(env: Env, now: Date = new Date()): Promise<PassExpirySweepResult> {
  const yesterday = isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS);
  const watermark = await env.DB.prepare("SELECT last_run_at FROM etl_sync_state WHERE job_name = ?")
    .bind(PASS_EXPIRY_SWEEP_JOB)
    .first<{ last_run_at: number }>();
  // Exclusive lower bound: the last date already covered.
  const after = watermark ? isoDate(watermark.last_run_at) : isoDate(Date.parse(`${yesterday}T00:00:00Z`) - DAY_MS);

  // Revoked and expelled members are left out: their passes were refreshed
  // when that was decided, and already carry no expiry.
  const { results } = await env.DB.prepare(
    `SELECT m.member_id, m.expiration_date
       FROM members m
      WHERE m.expiration_date > ?1 AND m.expiration_date <= ?2
        AND NOT EXISTS (SELECT 1 FROM revoked_cards r WHERE r.member_id = m.member_id)
        AND NOT EXISTS (SELECT 1 FROM expelled_people e WHERE e.email = m.email)
      ORDER BY m.expiration_date, m.member_id
      LIMIT ?3`,
  )
    .bind(after, yesterday, MAX_MEMBERS_PER_SWEEP)
    .all<{ member_id: string; expiration_date: string }>();

  for (const { member_id } of results) {
    await env.DB.prepare("UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE member_id = ?")
      .bind(member_id)
      .run();
    await notifyWalletsUpdated(env, member_id);
  }

  // A full batch may have stopped partway through its last date, so cover
  // only up to the day before it; the rest of that date comes next time, and
  // a pass refreshed twice is harmless. (More than the cap on one single date
  // would never finish, which a membership roll of this size cannot reach.)
  const coveredThrough =
    results.length === MAX_MEMBERS_PER_SWEEP
      ? isoDate(Date.parse(`${results[results.length - 1].expiration_date}T00:00:00Z`) - DAY_MS)
      : yesterday;
  await env.DB.prepare(
    `INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(job_name) DO UPDATE SET
       last_run_at = MAX(etl_sync_state.last_run_at, excluded.last_run_at),
       updated_at = excluded.updated_at`,
  )
    .bind(PASS_EXPIRY_SWEEP_JOB, Date.parse(`${coveredThrough}T00:00:00Z`), Date.now())
    .run();

  console.log("pass expiry sweep", { refreshed: results.length, after, coveredThrough });
  return { refreshed: results.length, coveredThrough };
}

/** Members per message for the one-off refresh; each costs a handful of D1 queries. */
export const LAPSED_REFRESH_BATCH = 100;

/**
 * The one-off companion to the daily sweep: refresh the passes of every
 * member whose membership had already lapsed before the sweep existed, so
 * passes still saying "active" learn otherwise and gain the wallets' native
 * expiry. Run deliberately (`just etl-run <env> refresh-lapsed-passes`), not
 * on a schedule: it is a push to many devices at once, though never an email.
 *
 * One batch per call, walking members in id order. Returns the cursor for the
 * next batch, or `null` when there is none; the queue consumer chains them.
 */
export async function refreshLapsedPasses(
  env: Env,
  afterMemberId: string = "",
  now: Date = new Date(),
): Promise<string | null> {
  const today = isoDate(now.getTime());
  // A member is skipped only when their pass already states the expiry, which
  // takes both of the clauses below and neither alone.
  //
  // Rebuilt in the last day: built by whatever is deployed now, so it carries
  // the wallets' native expiry. A pass rebuilt before #295 shipped does not,
  // however long ago the membership ended, and is exactly what this run is
  // for.
  //
  // And rebuilt after the membership ended: a pass built while the membership
  // was still current says so, because `effectiveStatus()` is worked out when
  // the pass is built. A name changed on the morning of the last day produces
  // one of those -- filed away by the wallets on time, still reading "Active"
  // on the back -- and the daily sweep will not revisit a date it has already
  // covered.
  const alreadyFresh = now.getTime() - DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT m.member_id
       FROM members m
      WHERE m.member_id > ?1 AND m.expiration_date < ?2
        AND NOT (
          m.last_updated_at >= ?4
          AND m.last_updated_at >= unixepoch(m.expiration_date || 'T23:59:59Z') * 1000
        )
        AND NOT EXISTS (SELECT 1 FROM revoked_cards r WHERE r.member_id = m.member_id)
        AND NOT EXISTS (SELECT 1 FROM expelled_people e WHERE e.email = m.email)
      ORDER BY m.member_id
      LIMIT ?3`,
  )
    .bind(afterMemberId, today, LAPSED_REFRESH_BATCH, alreadyFresh)
    .all<{ member_id: string }>();

  for (const { member_id } of results) {
    await env.DB.prepare("UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE member_id = ?")
      .bind(member_id)
      .run();
    await notifyWalletsUpdated(env, member_id);
  }
  console.log("lapsed pass refresh", { refreshed: results.length, afterMemberId });
  return results.length === LAPSED_REFRESH_BATCH ? results[results.length - 1].member_id : null;
}
