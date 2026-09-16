import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueEtlSync,
  handleEtlSyncBatch,
  type EtlSyncMessage,
} from "../../src/queues/etlSync";

function makeMessage(
  body: EtlSyncMessage,
  attempts = 0,
): Message<EtlSyncMessage> {
  return {
    id: "test-message-id",
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<EtlSyncMessage>;
}

function makeBatch(
  messages: Message<EtlSyncMessage>[],
): MessageBatch<EtlSyncMessage> {
  return {
    queue: "etl-sync",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<EtlSyncMessage>;
}

describe("enqueueEtlSync", () => {
  // wrangler.toml binds the real etl-sync queue, which the test runtime
  // provisions locally. Tests swap in a fake or remove the binding
  // explicitly, so nothing is ever delivered to the local consumer.
  const realQueue = env.ETL_SYNC_QUEUE;

  afterEach(() => {
    vi.restoreAllMocks();
    env.ETL_SYNC_QUEUE = realQueue;
  });

  it("no-ops with a warning when ETL_SYNC_QUEUE isn't bound (e.g. the preview environment)", async () => {
    delete (env as { ETL_SYNC_QUEUE?: unknown }).ETL_SYNC_QUEUE;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      enqueueEtlSync(env, { type: "run_slack_members_etl" }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no ETL_SYNC_QUEUE binding in this environment"),
      expect.anything(),
    );
  });

  it("sends the message onto ETL_SYNC_QUEUE when bound", async () => {
    const sent: EtlSyncMessage[] = [];
    (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
      send: async (message: EtlSyncMessage) => {
        sent.push(message);
      },
    } as unknown as Queue<EtlSyncMessage>;

    await enqueueEtlSync(env, { type: "run_slack_members_etl" });

    expect(sent).toEqual([{ type: "run_slack_members_etl" }]);
  });
});

describe("handleEtlSyncBatch", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    env.BIGCOMMERCE_STORE_HASH = "store123";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.exec("DELETE FROM members");
    await env.DB.exec("DELETE FROM etl_sync_state");
  });

  it("dispatches sync_bigcommerce_order and acks on success", async () => {
    const order = {
      id: 4242,
      customer_id: 7,
      status: "Complete",
      date_created: "2026-01-15T00:00:00.000Z",
      date_modified: "2026-01-15T00:00:00.000Z",
      billing_address: {
        first_name: "Pat",
        last_name: "Lee",
        email: "pat.lee@example.com",
      },
    };
    const products = [
      { id: 1, product_id: 100, sku: "LOSV-MEM-0001", name: "Los Verdes Annual Membership" },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/orders/${order.id}/products`)) {
          return new Response(JSON.stringify(products), { status: 200 });
        }
        if (url.endsWith(`/orders/${order.id}`)) {
          return new Response(JSON.stringify(order), { status: 200 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    const message = makeMessage({
      type: "sync_bigcommerce_order",
      orderId: String(order.id),
      storeHash: "store123",
    });

    await handleEtlSyncBatch(makeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const member = await env.DB.prepare(
      "SELECT * FROM members WHERE email = ?",
    )
      .bind("pat.lee@example.com")
      .first();
    expect(member).not.toBeNull();
  });

  it("dispatches sync_subscriptions_etl and acks on success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    const message = makeMessage({
      type: "sync_subscriptions_etl",
      loadAll: true,
    });

    await handleEtlSyncBatch(makeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("dispatches the sync_customers_etl / sync_minibc_subscriptions_etl stubs and acks", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const customersMessage = makeMessage({ type: "sync_customers_etl" });
    const minibcMessage = makeMessage({
      type: "sync_minibc_subscriptions_etl",
    });

    await handleEtlSyncBatch(
      makeBatch([customersMessage, minibcMessage]),
      env,
    );

    expect(customersMessage.ack).toHaveBeenCalledOnce();
    expect(minibcMessage.ack).toHaveBeenCalledOnce();
  });

  it("no-ops run_slack_members_etl (out of BigCommerce-ingestion scope) but still acks", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = makeMessage({ type: "run_slack_members_etl" });

    await handleEtlSyncBatch(makeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("run_slack_members_etl"),
    );
  });

  it("retries a failing message with backoff and does not fail the rest of the batch", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("BigCommerce API is down"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const failing = makeMessage(
      { type: "sync_bigcommerce_order", orderId: "1", storeHash: "store123" },
      2,
    );
    const succeeding = makeMessage({ type: "run_slack_members_etl" });

    await handleEtlSyncBatch(makeBatch([failing, succeeding]), env);

    expect(failing.ack).not.toHaveBeenCalled();
    expect(failing.retry).toHaveBeenCalledOnce();
    expect(failing.retry).toHaveBeenCalledWith({
      delaySeconds: expect.any(Number),
    });
    // One message's failure must not block or fail the rest of the batch.
    expect(succeeding.ack).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "etl-sync handler failed",
      expect.objectContaining({ type: "sync_bigcommerce_order", attempts: 2 }),
    );
  });
});
