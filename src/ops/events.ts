/**
 * A tally of operational failures, for the hourly watch to count (#56).
 *
 * Workers Logs already holds the detail, but querying it from the Worker
 * would need a Cloudflare API token in every environment. A failure worth
 * counting is cheap to record where it happens, so that is what this does:
 * one row, a category, and at most a short categorical detail.
 *
 * Nothing here identifies a person -- no address, name, order number or
 * serial -- for the same reason outcome lines carry none (src/lib/outcome.ts):
 * this is read by whoever is on the end of an alert, and a count is the whole
 * signal.
 *
 * Recording never throws and never blocks the caller's own failure handling:
 * the thing that just went wrong is more important than the tally of it.
 */

import type { Env } from "../index";

export const OPS_EVENT_KINDS = [
  /** A request no route handled (src/lib/serverError.tsx). */
  "unhandled_error",
] as const;

export type OpsEventKind = (typeof OPS_EVENT_KINDS)[number];

/** How long a counted event is kept; the watch prunes anything older. */
export const OPS_EVENT_RETENTION_DAYS = 7;

export async function recordOpsEvent(env: Env, kind: OpsEventKind, detail?: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO ops_events (kind, detail) VALUES (?, ?)")
      .bind(kind, detail?.slice(0, 200) ?? null)
      .run();
  } catch (error) {
    console.warn("ops: could not record an event", { kind, error: String(error) });
  }
}

/** How many of `kind` were recorded in the last `hours`. */
export async function countOpsEvents(env: Env, kind: OpsEventKind, hours: number, now: Date): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM ops_events WHERE kind = ? AND occurred_at > ?",
  )
    .bind(kind, now.getTime() - hours * 3_600_000)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function pruneOpsEvents(env: Env, now: Date): Promise<void> {
  await env.DB.prepare("DELETE FROM ops_events WHERE occurred_at < ?")
    .bind(now.getTime() - OPS_EVENT_RETENTION_DAYS * 86_400_000)
    .run();
}
