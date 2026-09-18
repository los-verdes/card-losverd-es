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
  const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxx";

  /** Captures what, if anything, was posted to Slack. */
  function mockSlack(status = 200) {
    const posts: { url: string; text: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      posts.push({ url, text: JSON.parse(String(init?.body)).text });
      return new Response("ok", { status });
    });
    return posts;
  }

  it("logs and acks every dead-lettered message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = makeMessage({ type: "sync_bigcommerce_order", orderId: "1" }, 6);
    const second = makeMessage({ type: "sync_subscriptions_etl" }, 6);

    await handleDeadLetterBatch(makeBatch("etl-sync-dlq", [first, second]), env);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "Dead-lettered queue message",
      expect.objectContaining({ queue: "etl-sync-dlq", attempts: 6, body: first.body }),
    );
  });

  it("alerts Slack once for the batch, naming the queue and what failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = mockSlack();
    const batch = makeBatch("etl-sync-dlq", [
      makeMessage({ type: "sync_bigcommerce_order", orderId: "1001_bc" }, 6),
      makeMessage({ type: "sync_subscriptions_etl" }, 6),
    ]);

    await handleDeadLetterBatch(batch, { ...env, SLACK_ALERT_WEBHOOK_URL: WEBHOOK });

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(WEBHOOK);
    expect(posts[0].text).toContain("2 messages dead-lettered");
    expect(posts[0].text).toContain("etl-sync-dlq");
    expect(posts[0].text).toContain("sync_bigcommerce_order");
    expect(posts[0].text).toContain("6 attempts");
  });

  it("keeps member data out of the alert, which a channel sees and our logs don't", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = mockSlack();
    const batch = makeBatch("etl-sync-dlq", [
      makeMessage({ type: "sync_bigcommerce_order", orderId: "1001_bc", email: "someone@example.com" }, 6),
    ]);

    await handleDeadLetterBatch(batch, { ...env, SLACK_ALERT_WEBHOOK_URL: WEBHOOK });

    expect(posts[0].text).not.toContain("1001_bc");
    expect(posts[0].text).not.toContain("someone@example.com");
    // The type is enough to know what broke; the log has the rest.
    expect(posts[0].text).toContain("sync_bigcommerce_order");
  });

  it("says so rather than guessing when a body has no recognisable type", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = mockSlack();

    await handleDeadLetterBatch(
      makeBatch("etl-sync-dlq", [makeMessage("not an object", 3)]),
      { ...env, SLACK_ALERT_WEBHOOK_URL: WEBHOOK },
    );

    expect(posts[0].text).toContain("1 message dead-lettered");
    expect(posts[0].text).toContain("unknown");
  });

  it("doesn't post, or fail, when no webhook is configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = mockSlack();
    const message = makeMessage({ type: "sync_customers_etl" }, 6);

    await expect(
      handleDeadLetterBatch(makeBatch("etl-sync-dlq", [message]), {
        ...env,
        SLACK_ALERT_WEBHOOK_URL: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(posts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SLACK_ALERT_WEBHOOK_URL"));
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("acks the batch even when Slack rejects the alert", async () => {
    // An alert failing must not leave the batch to be retried forever.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSlack(500);
    const message = makeMessage({ type: "sync_customers_etl" }, 6);

    await handleDeadLetterBatch(makeBatch("etl-sync-dlq", [message]), {
      ...env,
      SLACK_ALERT_WEBHOOK_URL: WEBHOOK,
    });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "postSlackAlert(): Slack rejected the alert",
      expect.objectContaining({ status: 500 }),
    );
  });

  it("survives Slack being unreachable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const message = makeMessage({ type: "sync_customers_etl" }, 6);

    await handleDeadLetterBatch(makeBatch("etl-sync-dlq", [message]), {
      ...env,
      SLACK_ALERT_WEBHOOK_URL: WEBHOOK,
    });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "postSlackAlert(): couldn't reach Slack",
      expect.objectContaining({ error: expect.stringContaining("network down") }),
    );
  });

  it("posts nothing for an empty batch", async () => {
    const posts = mockSlack();

    await handleDeadLetterBatch(makeBatch("etl-sync-dlq", []), {
      ...env,
      SLACK_ALERT_WEBHOOK_URL: WEBHOOK,
    });

    expect(posts).toEqual([]);
  });
});
