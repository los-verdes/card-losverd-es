import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as etlSync from "../../src/queues/etlSync";
import { handleDeadLetterBatch, handleQueueBatch } from "../../src/queues";
import worker from "../../src/index";

function makeMessage(body: unknown, attempts = 6) {
  return { id: "msg-1", timestamp: new Date(), body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(queue: string, messages: ReturnType<typeof makeMessage>[]) {
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleQueueBatch", () => {
  it("routes by this environment's configured queue names (e.g. staging's)", async () => {
    const spy = vi.spyOn(etlSync, "handleEtlSyncBatch").mockResolvedValue();
    const stagingEnv = { ...env, ETL_SYNC_QUEUE_NAME: "etl-sync-staging", ETL_SYNC_DLQ_NAME: "etl-sync-dlq-staging" };
    const batch = makeBatch("etl-sync-staging", [makeMessage({ type: "sync_customers_etl" })]);

    await handleQueueBatch(batch, stagingEnv);
    expect(spy).toHaveBeenCalledWith(batch, stagingEnv);

    // Production's names mean nothing to the staging Worker.
    await expect(handleQueueBatch(makeBatch("etl-sync-production", []), stagingEnv)).rejects.toThrow(/No consumer registered/);
  });

  it("routes etl-sync batches to the etl-sync consumer", async () => {
    const spy = vi.spyOn(etlSync, "handleEtlSyncBatch").mockResolvedValue();
    const batch = makeBatch(env.ETL_SYNC_QUEUE_NAME, [makeMessage({ type: "sync_customers_etl" })]);

    await handleQueueBatch(batch, env);

    expect(spy).toHaveBeenCalledWith(batch, env);
  });

  it("routes etl-sync-dlq batches to the dead-letter consumer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const message = makeMessage({ type: "sync_customers_etl" });

    await handleQueueBatch(makeBatch(env.ETL_SYNC_DLQ_NAME, [message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("throws (leaving the batch to retry) for a queue with no consumer", async () => {
    const message = makeMessage({});
    await expect(handleQueueBatch(makeBatch("member-actions", [message]), env)).rejects.toThrow(
      /No consumer registered for queue "member-actions"/,
    );
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("is the Worker's queue() entrypoint", () => {
    expect(worker.queue).toBe(handleQueueBatch);
  });
});

describe("handleDeadLetterBatch", () => {
  it("logs and acks every dead-lettered message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = makeMessage({ type: "sync_bigcommerce_order", orderId: "1" }, 6);
    const second = makeMessage({ type: "sync_subscriptions_etl" }, 6);

    await handleDeadLetterBatch(makeBatch("etl-sync-dlq", [first, second]));

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "Dead-lettered queue message",
      expect.objectContaining({ queue: "etl-sync-dlq", attempts: 6, body: first.body }),
    );
  });
});
