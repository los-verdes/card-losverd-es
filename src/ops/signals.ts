/**
 * The questions the hourly watch asks (#56).
 *
 * A signal is a named question with a threshold, answered over a window:
 * "more than ten unhandled errors in the last hour", "no order resync in
 * twelve". Each answers firing or not, with one line a person can act on.
 *
 * Thresholds rather than any-occurrence, because the point is to be worth
 * reading: one 500 is a bad minute, twenty in an hour is a fault. What turns
 * a firing signal into an alert -- and what stops it being said twice -- is
 * src/ops/watch.ts; this file only measures.
 *
 * Every signal is also shown on `/admin/preflight`, so a quiet Slack never
 * means nobody could have known.
 */

import type { Env } from "../index";
import { countOpsEvents } from "./events";
import { MINIBC_JOB_NAME } from "../minibc/subscriptions";
import { agoText } from "../admin/when";

export interface Signal {
  /** Stable across runs: it keys the alert state. */
  name: string;
  firing: boolean;
  /**
   * Worth showing on the readiness page, but not worth an alert: a job that
   * has never run here, which is how a new environment looks.
   */
  notable?: boolean;
  detail: string;
}

/**
 * Hours since a job last completed, or null when it has never run here.
 *
 * `updated_at`, not `last_run_at`. Every job writes the moment it finished
 * into the first; the second is a watermark meaning whatever that job needs it
 * to mean. The resync's happens to be a time, so the two agreed and the
 * difference did not show. The sweep's is the last expiry *date* it has
 * covered, stored as midnight UTC and a full day behind by design -- so a
 * sweep running perfectly every night looked 38 hours stale by the time the
 * next one was due, and this signal was hours away from saying so in Slack.
 */
async function hoursSinceJob(env: Env, jobName: string, now: Date): Promise<number | null> {
  const row = await env.DB.prepare("SELECT updated_at FROM etl_sync_state WHERE job_name = ?")
    .bind(jobName)
    .first<{ updated_at: number }>();
  return row ? (now.getTime() - row.updated_at) / 3_600_000 : null;
}

/**
 * A job that has never run is not firing. An environment that was just built
 * has never run anything, and an alert that greets a new environment with
 * five complaints teaches people to ignore it. The readiness page says so
 * instead.
 */
function staleness(name: string, hours: number | null, limit: number, cadence: string): Signal {
  if (hours === null) {
    return {
      name,
      firing: false,
      notable: true,
      detail: `Has never completed here. It runs ${cadence} once the environment's cron triggers are on.`,
    };
  }
  const rounded = Math.floor(hours);
  return {
    name,
    firing: hours >= limit,
    detail:
      hours >= limit
        ? `Last completed ${rounded} hours ago; it runs ${cadence}. Either the cron is not enabled or the job is failing.`
        : `Last completed ${rounded} hours ago.`,
  };
}

/** Weekly, so a day's grace before a missing one is worth saying. */
export const FULL_RESYNC_STALE_DAYS = 8;
/** A running resync writes its row with every queue message, minutes apart. */
export const FULL_RESYNC_STALLED_HOURS = 2;

interface FullResyncRow {
  started_at: number;
  orders_read: number;
  cards_changed: number;
  listed_at: number | null;
  rechecked: number | null;
  flagged: number | null;
  finished_at: number | null;
  updated_at: number;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How a finished resync ended. */
function fullResyncOutcome(row: FullResyncRow, now: number): string {
  return (
    `finished ${agoText(row.finished_at!, now)}: ${plural(row.orders_read, "membership order", "membership orders")} read, ` +
    `${plural(row.cards_changed, "card", "cards")} changed; ` +
    `${plural(row.rechecked ?? 0, "order", "orders")} the store's list did not return re-read, ${row.flagged ?? 0} newly missing`
  );
}

/**
 * The full resync (src/db/migrations/0017_full_resyncs.sql): how far a
 * running one has got, or how the last one ended. Firing when a running one
 * has stopped moving, or none has finished for over a week.
 */
async function fullResyncSignal(env: Env, now: Date): Promise<Signal> {
  const name = "Full resync";
  const at = now.getTime();
  const [latest, lastFinished] = await Promise.all([
    env.DB.prepare("SELECT * FROM full_resyncs ORDER BY started_at DESC LIMIT 1").first<FullResyncRow>(),
    env.DB.prepare("SELECT * FROM full_resyncs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1").first<FullResyncRow>(),
  ]);
  const stale = !lastFinished || at - lastFinished.finished_at! > FULL_RESYNC_STALE_DAYS * 86_400_000;
  const staleText = " It runs weekly, early on Sunday; either the cron is not enabled or the resync is failing.";
  if (!latest) {
    return {
      name,
      firing: false,
      notable: true,
      detail: "Has never run here since this was recorded. It runs weekly, early on Sunday, or by hand with `just etl-run <env> full-resync`.",
    };
  }
  if (latest.finished_at !== null) {
    return { name, firing: stale, detail: `The last one ${fullResyncOutcome(latest, at)}.${stale ? staleText : ""}` };
  }

  const stalled = at - latest.updated_at > FULL_RESYNC_STALLED_HOURS * 3_600_000;
  const phase =
    latest.listed_at === null
      ? `reading the store's order list: ${plural(latest.orders_read, "membership order", "membership orders")} so far, ` +
        `${plural(latest.cards_changed, "card", "cards")} changed`
      : `list read (${plural(latest.orders_read, "membership order", "membership orders")}, ${plural(latest.cards_changed, "card", "cards")} changed), ` +
        `now re-reading orders it did not return: ${(latest.rechecked ?? 0).toLocaleString("en-US")} so far`;
  return {
    name,
    firing: stalled || stale,
    detail:
      `Running, started ${agoText(latest.started_at, at)}, ${phase}; last progress ${agoText(latest.updated_at, at)}.` +
      (stalled ? ` Nothing for over ${FULL_RESYNC_STALLED_HOURS} hours, so it has probably stopped: Workers Logs has why.` : "") +
      (lastFinished ? ` The previous one ${fullResyncOutcome(lastFinished, at)}.` : "") +
      (stale && !stalled ? staleText : ""),
  };
}

export const UNHANDLED_ERRORS_PER_HOUR = 10;
export const DEVICE_REPORTS_PER_DAY = 20;

/**
 * Every signal, measured. Order is the order they appear in Slack and on the
 * readiness page.
 */
export async function evaluateSignals(env: Env, now: Date = new Date()): Promise<Signal[]> {
  const errors = await countOpsEvents(env, "unhandled_error", 1, now);
  const deviceReports = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pass_device_logs WHERE logged_at > ?",
  )
    .bind(now.getTime() - 86_400_000)
    .first<{ n: number }>();
  const reports = deviceReports?.n ?? 0;

  return [
    {
      name: "Unhandled errors",
      firing: errors > UNHANDLED_ERRORS_PER_HOUR,
      detail:
        errors === 0
          ? "None in the last hour."
          : `${errors} in the last hour (alerting above ${UNHANDLED_ERRORS_PER_HOUR}). Workers Logs has the detail: search for "Unhandled error".`,
    },
    {
      name: "Wallet passes reporting failures",
      firing: reports > DEVICE_REPORTS_PER_DAY,
      detail:
        reports === 0
          ? "No device reported a problem in the last day."
          : `${reports} reports from devices in the last day (alerting above ${DEVICE_REPORTS_PER_DAY}). These are phones telling us their pass could not register or update; "What phones reported" on /admin/preflight groups them by what went wrong.`,
    },
    staleness("Order resync", await hoursSinceJob(env, "sync_subscriptions_etl", now), 12, "six-hourly"),
    await fullResyncSignal(env, now),
    staleness("Pass expiry sweep", await hoursSinceJob(env, "pass_expiry_sweep", now), 36, "daily"),
    // Only where there is a key to read with: without one it never runs,
    // which is how staging is meant to be rather than something to fix.
    ...(env.MINIBC_API_KEY
      ? [staleness("MiniBC subscriptions", await hoursSinceJob(env, MINIBC_JOB_NAME, now), 36, "twice a day")]
      : []),
  ];
}
