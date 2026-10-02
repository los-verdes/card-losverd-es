import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_REPORTS_PER_DAY,
  FULL_RESYNC_STALE_DAYS,
  FULL_RESYNC_STALLED_HOURS,
  UNHANDLED_ERRORS_PER_HOUR,
  evaluateSignals,
} from "../../src/ops/signals";
import { REMINDER_AFTER_HOURS, RUNS_BEFORE_ALERTING, runOpsWatch } from "../../src/ops/watch";

const NOW = new Date("2026-09-22T12:10:00Z");
const HOUR = 3_600_000;

/** What was posted to Slack, in order. */
let posted: string[];

function laterBy(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR);
}

async function errors(count: number, at: Date = NOW) {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare("INSERT INTO ops_events (kind, detail, occurred_at) VALUES ('unhandled_error', 'GET /x', ?)")
      .bind(at.getTime() - 60_000)
      .run();
  }
}

/** A job that completed `hours` ago, so its freshness signal is quiet. */
async function jobRan(jobName: string, hoursAgo: number, at: Date = NOW) {
  const finishedAt = at.getTime() - hoursAgo * HOUR;
  await env.DB.prepare("INSERT OR REPLACE INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)")
    .bind(jobName, finishedAt, finishedAt)
    .run();
}

beforeEach(async () => {
  posted = [];
  env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/C";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    posted.push(JSON.parse(String(init?.body)).text);
    return new Response("ok", { status: 200 });
  });
  // Quiet by default: both scheduled jobs ran recently.
  await jobRan("sync_subscriptions_etl", 1);
  await jobRan("pass_expiry_sweep", 2);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.SLACK_ALERT_WEBHOOK_URL = undefined;
  await env.DB.exec("DELETE FROM ops_events");
  await env.DB.exec("DELETE FROM ops_alert_state");
  await env.DB.exec("DELETE FROM etl_sync_state");
  await env.DB.exec("DELETE FROM pass_device_logs");
  await env.DB.exec("DELETE FROM full_resyncs");
});

/** A row of `full_resyncs`, times in hours before NOW; null leaves a step undone. */
async function fullResync(row: {
  started: number;
  updated: number;
  ordersRead?: number;
  cardsChanged?: number;
  listed?: number | null;
  rechecked?: number | null;
  flagged?: number | null;
  finished?: number | null;
}) {
  const at = (hours: number | null | undefined) => (hours === null || hours === undefined ? null : NOW.getTime() - hours * HOUR);
  await env.DB.prepare(
    `INSERT INTO full_resyncs (started_at, orders_read, cards_changed, listed_at, rechecked, flagged, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(at(row.started), row.ordersRead ?? 0, row.cardsChanged ?? 0, at(row.listed), row.rechecked ?? null, row.flagged ?? null, at(row.finished), at(row.updated))
    .run();
}

describe("the signals", () => {
  it("are all quiet when nothing is wrong", async () => {
    const signals = await evaluateSignals(env, NOW);

    expect(signals.map((s) => s.firing)).toEqual([false, false, false, false, false]);
  });

  describe("for the full resync", () => {
    const signal = async () => (await evaluateSignals(env, NOW)).find((s) => s.name === "Full resync")!;

    it("say it has never run, without firing, before one has", async () => {
      expect(await signal()).toMatchObject({ firing: false, notable: true, detail: expect.stringContaining("Has never run here") });
    });

    it("say how the last one ended", async () => {
      await fullResync({ started: 9, listed: 8, finished: 7, updated: 7, ordersRead: 2410, cardsChanged: 3, rechecked: 12, flagged: 1 });

      expect(await signal()).toEqual({
        name: "Full resync",
        firing: false,
        detail:
          "The last one finished 7 hours ago: 2,410 membership orders read, 3 cards changed; 12 orders the store's list did not return re-read, 1 newly missing.",
      });
    });

    it("show a running one's progress through the list, then through the re-reads, with the one before", async () => {
      await fullResync({ started: 24 * 7, listed: 24 * 7, finished: 24 * 7 - 1, updated: 24 * 7 - 1, ordersRead: 2400, rechecked: 10, flagged: 0 });
      await fullResync({ started: 1, updated: 0.1, ordersRead: 600, cardsChanged: 1 });

      const listing = await signal();
      expect(listing.firing).toBe(false);
      expect(listing.detail).toContain("Running, started 1 hour ago, reading the store's order list: 600 membership orders so far, 1 card changed;");
      expect(listing.detail).toContain("The previous one finished 7 days ago: 2,400 membership orders read");

      await env.DB.prepare("UPDATE full_resyncs SET listed_at = ?, rechecked = 30 WHERE orders_read = 600").bind(NOW.getTime() - HOUR / 2).run();
      expect((await signal()).detail).toContain("list read (600 membership orders, 1 card changed), now re-reading orders it did not return: 30 so far");
    });

    it("fire on a running one that has stopped moving", async () => {
      await fullResync({ started: FULL_RESYNC_STALLED_HOURS + 3, updated: FULL_RESYNC_STALLED_HOURS + 1, ordersRead: 120 });

      expect(await signal()).toMatchObject({ firing: true, detail: expect.stringContaining("it has probably stopped") });
    });

    it("fire when none has finished for over a week", async () => {
      const old = FULL_RESYNC_STALE_DAYS * 24 + 1;
      await fullResync({ started: old + 1, listed: old + 1, finished: old, updated: old, rechecked: 0, flagged: 0 });

      expect(await signal()).toMatchObject({ firing: true, detail: expect.stringContaining("either the cron is not enabled") });
    });
  });

  it("watch the MiniBC read only where there is a key to read with", async () => {
    const minibc = async () => (await evaluateSignals(env, NOW)).find((s) => s.name === "MiniBC subscriptions");
    expect(await minibc()).toBeUndefined();

    env.MINIBC_API_KEY = "test-minibc-key";
    try {
      expect(await minibc()).toMatchObject({ firing: false, detail: expect.stringContaining("Has never completed here.") });
      await jobRan("sync_minibc_subscriptions_etl", 37);
      expect(await minibc()).toMatchObject({ firing: true, detail: expect.stringContaining("twice a day") });
    } finally {
      env.MINIBC_API_KEY = undefined;
    }
  });

  it("do not fire for a job that has never run here, which is a new environment rather than a fault", async () => {
    await env.DB.exec("DELETE FROM etl_sync_state");

    const resync = (await evaluateSignals(env, NOW)).find((s) => s.name === "Order resync");

    expect(resync?.firing).toBe(false);
    expect(resync?.detail).toContain("Has never completed here.");
  });

  it("fire on a stale resync, and say what it means", async () => {
    await jobRan("sync_subscriptions_etl", 13);

    const resync = (await evaluateSignals(env, NOW)).find((s) => s.name === "Order resync");

    expect(resync?.firing).toBe(true);
    expect(resync?.detail).toContain("13 hours ago");
  });

  it("stay quiet for a sweep whose watermark is a day behind, which is how a healthy one looks", async () => {
    // The sweep's `last_run_at` is the last expiry date it covered, stored as
    // midnight UTC, so it trails the run that wrote it by more than a day.
    // Read as a completion time it made a nightly sweep look stale every
    // night, just before the next one was due.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES ('pass_expiry_sweep', ?, ?)",
    )
      .bind(Date.parse("2026-09-21T00:00:00Z"), NOW.getTime() - 2 * HOUR)
      .run();

    const sweep = (await evaluateSignals(env, NOW)).find((s) => s.name === "Pass expiry sweep");

    expect(sweep?.firing).toBe(false);
    expect(sweep?.detail).toContain("2 hours ago");
  });

  it("fire on a pile of device-reported pass failures, which is what went unnoticed before", async () => {
    for (let i = 0; i <= DEVICE_REPORTS_PER_DAY; i++) {
      await env.DB.prepare("INSERT INTO pass_device_logs (message, logged_at) VALUES ('Register task ... error', ?)")
        .bind(NOW.getTime() - HOUR)
        .run();
    }

    const signal = (await evaluateSignals(env, NOW)).find((s) => s.name === "Wallet passes reporting failures");

    expect(signal?.firing).toBe(true);
  });

  it("ignore errors older than the window", async () => {
    await errors(UNHANDLED_ERRORS_PER_HOUR + 5, new Date(NOW.getTime() - 3 * HOUR));

    const signal = (await evaluateSignals(env, NOW)).find((s) => s.name === "Unhandled errors");

    expect(signal).toMatchObject({ firing: false, detail: "None in the last hour." });
  });
});

describe("the hourly watch", () => {
  it("says nothing about a single bad hour", async () => {
    await errors(UNHANDLED_ERRORS_PER_HOUR + 1);

    expect(await runOpsWatch(env, NOW)).toEqual({ alerted: [], recovered: [] });
    expect(posted).toEqual([]);
  });

  it("speaks up once the same thing is still wrong on the next run", async () => {
    await errors(UNHANDLED_ERRORS_PER_HOUR + 1);
    await runOpsWatch(env, NOW);
    await errors(UNHANDLED_ERRORS_PER_HOUR + 1, laterBy(1));

    const outcome = await runOpsWatch(env, laterBy(1));

    expect(outcome.alerted).toEqual(["Unhandled errors"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Unhandled errors");
    expect(posted[0]).toContain("/admin/preflight");
  });

  it("then holds its tongue for a day, and reminds once after that", async () => {
    await jobRan("sync_subscriptions_etl", 13);
    for (let run = 0; run < RUNS_BEFORE_ALERTING; run++) await runOpsWatch(env, laterBy(run));
    expect(posted).toHaveLength(1);

    // Still broken, hour after hour: nothing more is said. The first alert
    // landed on the second run, so the reminder is due an hour after that.
    const remindAt = RUNS_BEFORE_ALERTING - 1 + REMINDER_AFTER_HOURS;
    for (let hour = 2; hour < remindAt; hour++) {
      await jobRan("sync_subscriptions_etl", 13 + hour, laterBy(hour));
      await runOpsWatch(env, laterBy(hour));
    }
    expect(posted).toHaveLength(1);

    await jobRan("sync_subscriptions_etl", 13 + remindAt, laterBy(remindAt));
    await runOpsWatch(env, laterBy(remindAt));

    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("Still");
  });

  it("says when it is over, once", async () => {
    await jobRan("sync_subscriptions_etl", 13);
    for (let run = 0; run < RUNS_BEFORE_ALERTING; run++) await runOpsWatch(env, laterBy(run));

    await jobRan("sync_subscriptions_etl", 1, laterBy(2));
    await runOpsWatch(env, laterBy(2));
    await runOpsWatch(env, laterBy(3));

    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("Back to normal");
  });

  it("stays silent about something that fixed itself before it was ever announced", async () => {
    await errors(UNHANDLED_ERRORS_PER_HOUR + 1);
    await runOpsWatch(env, NOW);
    await env.DB.exec("DELETE FROM ops_events");

    await runOpsWatch(env, laterBy(1));

    expect(posted).toEqual([]);
  });

  it("prunes counted events it no longer needs", async () => {
    await errors(2, new Date(NOW.getTime() - 30 * 24 * HOUR));

    await runOpsWatch(env, NOW);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_events").first()).toEqual({ n: 0 });
  });
});
