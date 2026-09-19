import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/scheduled";
import type { EtlSyncMessage } from "../src/queues/etlSync";

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        promises.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    async flush() {
      await Promise.all(promises);
    },
  };
}

function makeEvent(cron: string): ScheduledEvent {
  return {
    cron,
    type: "scheduled",
    scheduledTime: Date.now(),
  } as ScheduledEvent;
}

function withMockQueue(): EtlSyncMessage[] {
  const sent: EtlSyncMessage[] = [];
  (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
    send: async (message: EtlSyncMessage) => {
      sent.push(message);
    },
  } as unknown as Queue<EtlSyncMessage>;
  return sent;
}

describe("scheduled()", () => {
  const realQueue = env.ETL_SYNC_QUEUE;

  afterEach(() => {
    vi.restoreAllMocks();
    env.ETL_SYNC_QUEUE = realQueue;
  });

  const cases: [string, EtlSyncMessage][] = [
    ["0 */6 * * *", { type: "run_slack_members_etl" }],
    ["15 */6 * * *", { type: "sync_subscriptions_etl" }],
    ["30 * * * *", { type: "sync_customers_etl" }],
    ["30 */12 * * *", { type: "sync_minibc_subscriptions_etl" }],
    ["0 9 * * 1", { type: "run_readiness_check" }],
  ];

  for (const [cron, expectedMessage] of cases) {
    it(`enqueues the right etl-sync message for cron "${cron}"`, async () => {
      const sent = withMockQueue();
      const { ctx, flush } = makeCtx();

      await scheduled(makeEvent(cron), env, ctx);
      await flush();

      expect(sent).toEqual([expectedMessage]);
    });
  }

  it("warns and enqueues nothing for a cron string with no mapped message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent = withMockQueue();
    const { ctx, flush } = makeCtx();

    await scheduled(makeEvent("*/5 * * * *"), env, ctx);
    await flush();

    expect(sent).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("*/5 * * * *"),
    );
  });
});
