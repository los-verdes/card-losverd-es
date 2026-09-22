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

/** Hours since a watermark, or null when the job has never recorded one. */
async function hoursSinceJob(env: Env, jobName: string, now: Date): Promise<number | null> {
  const row = await env.DB.prepare("SELECT last_run_at FROM etl_sync_state WHERE job_name = ?")
    .bind(jobName)
    .first<{ last_run_at: number }>();
  return row ? (now.getTime() - row.last_run_at) / 3_600_000 : null;
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
          : `${reports} reports from devices in the last day (alerting above ${DEVICE_REPORTS_PER_DAY}). These are phones telling us their pass could not register or update; /admin/preflight links what they said.`,
    },
    staleness("Order resync", await hoursSinceJob(env, "sync_subscriptions_etl", now), 12, "six-hourly"),
    staleness("Pass expiry sweep", await hoursSinceJob(env, "pass_expiry_sweep", now), 36, "daily"),
  ];
}
