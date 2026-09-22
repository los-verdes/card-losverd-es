/**
 * The hourly watch: measure every signal, and decide what is worth saying
 * (#56).
 *
 * Prompted by a real miss. About thirty wallet passes had been failing to
 * register for days and nothing said so; it was found while reading the logs
 * for something else. A page nobody opens reports nothing, and the weekly
 * readiness post only speaks up for a check that has outright failed.
 *
 * The rules here are what make an hourly job bearable, and each exists
 * because the obvious version of this is a job people mute:
 *
 *   - **Sustained, not spiky.** A signal must fire on two consecutive runs
 *     before anything is posted, so one bad hour passes unremarked.
 *   - **Once, not hourly.** While it keeps firing, nothing more is said for
 *     a day.
 *   - **Recovery is said once**, so a thread ends instead of trailing off.
 *   - **Quiet is never unknown.** Every signal, firing or not, is on
 *     `/admin/preflight`.
 */

import type { Env } from "../index";
import { postSlackAlert } from "../slack/alert";
import { pruneOpsEvents } from "./events";
import { evaluateSignals } from "./signals";

/** Consecutive firing runs before a signal is worth saying out loud. */
export const RUNS_BEFORE_ALERTING = 2;

/** How long a signal that stays firing stays quiet after it was announced. */
export const REMINDER_AFTER_HOURS = 24;

interface AlertState {
  signal: string;
  consecutive: number;
  firing_since: number | null;
  last_alerted_at: number | null;
}

export interface WatchOutcome {
  /** Signals announced this run, as new problems or as reminders. */
  alerted: string[];
  /** Signals announced as recovered this run. */
  recovered: string[];
}

async function loadState(env: Env): Promise<Map<string, AlertState>> {
  const { results } = await env.DB.prepare(
    "SELECT signal, consecutive, firing_since, last_alerted_at FROM ops_alert_state",
  ).all<AlertState>();
  return new Map(results.map((row) => [row.signal, row]));
}

async function saveState(env: Env, state: AlertState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ops_alert_state (signal, consecutive, firing_since, last_alerted_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(signal) DO UPDATE SET
       consecutive = excluded.consecutive,
       firing_since = excluded.firing_since,
       last_alerted_at = excluded.last_alerted_at`,
  )
    .bind(state.signal, state.consecutive, state.firing_since, state.last_alerted_at)
    .run();
}

/** How long it has been firing, in words, for the alert text. */
function firingFor(since: number | null, now: Date): string {
  if (since === null) return "";
  const hours = Math.floor((now.getTime() - since) / 3_600_000);
  return hours >= 1 ? ` (${hours} hour${hours === 1 ? "" : "s"} so far)` : "";
}

/**
 * Runs the signals and posts what the rules above allow. Returns what was
 * said, so a caller (and a test) can tell silence from not having run.
 */
export async function runOpsWatch(env: Env, now: Date = new Date()): Promise<WatchOutcome> {
  const signals = await evaluateSignals(env, now);
  const state = await loadState(env);
  const outcome: WatchOutcome = { alerted: [], recovered: [] };

  for (const signal of signals) {
    const previous = state.get(signal.name) ?? {
      signal: signal.name,
      consecutive: 0,
      firing_since: null,
      last_alerted_at: null,
    };

    if (!signal.firing) {
      // Said something about it, and it is over: say so once.
      if (previous.last_alerted_at !== null) {
        await postSlackAlert(env, `:white_check_mark: Back to normal: *${signal.name}*. ${signal.detail}`);
        outcome.recovered.push(signal.name);
      }
      if (previous.consecutive !== 0 || previous.last_alerted_at !== null) {
        await saveState(env, { signal: signal.name, consecutive: 0, firing_since: null, last_alerted_at: null });
      }
      continue;
    }

    const consecutive = previous.consecutive + 1;
    const firingSince = previous.firing_since ?? now.getTime();
    const announced = previous.last_alerted_at;
    const due =
      announced === null
        ? consecutive >= RUNS_BEFORE_ALERTING
        : now.getTime() - announced >= REMINDER_AFTER_HOURS * 3_600_000;

    if (due) {
      const still = announced === null ? "" : "Still ";
      await postSlackAlert(
        env,
        `:rotating_light: ${still}*${signal.name}*${firingFor(firingSince, now)}: ${signal.detail} Everything the checks can see: /admin/preflight`,
      );
      outcome.alerted.push(signal.name);
    }
    await saveState(env, {
      signal: signal.name,
      consecutive,
      firing_since: firingSince,
      last_alerted_at: due ? now.getTime() : announced,
    });
  }

  await pruneOpsEvents(env, now);
  console.log("ops watch", {
    signals: signals.length,
    firing: signals.filter((s) => s.firing).length,
    alerted: outcome.alerted.length,
    recovered: outcome.recovered.length,
  });
  return outcome;
}
