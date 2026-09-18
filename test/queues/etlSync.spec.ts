import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORDERS_PAGE_SIZE } from "../../src/bigcommerce/sync";
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
    queue: "etl-sync-production",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<EtlSyncMessage>;
}

describe("enqueueEtlSync", () => {
  // wrangler.toml binds the real etl-sync queue, which the test runtime
  // provisions locally. Tests swap in a fake so nothing is ever delivered
  // to the local consumer, then restore the real binding.
  const realQueue = env.ETL_SYNC_QUEUE;

  afterEach(() => {
    vi.restoreAllMocks();
    env.ETL_SYNC_QUEUE = realQueue;
  });

  it("sends the message onto ETL_SYNC_QUEUE", async () => {
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
    await env.DB.exec("DELETE FROM membership_orders");
    await env.DB.exec("DELETE FROM members");
    await env.DB.exec("DELETE FROM etl_sync_state");
  });

  it("dispatches sync_bigcommerce_order and acks on success", async () => {
    const order = {
      id: 4242,
      customer_id: 7,
      status: "Completed",
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

  describe("sync_subscriptions_etl", () => {
    // Same fake-queue swap as enqueueEtlSync's tests: follow-up messages
    // are captured instead of delivered to the local consumer.
    const realQueue = env.ETL_SYNC_QUEUE;
    let sent: EtlSyncMessage[];

    beforeEach(() => {
      sent = [];
      (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
        send: async (message: EtlSyncMessage) => {
          sent.push(message);
        },
      } as unknown as Queue<EtlSyncMessage>;
    });

    afterEach(() => {
      env.ETL_SYNC_QUEUE = realQueue;
    });

    /** A full page of synthetic merchandise orders, ids 1..250. */
    function mockFullPageOfMerchandise(productsStatus = 200) {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/orders?")) {
            const orders = Array.from({ length: ORDERS_PAGE_SIZE }, (_, i) => ({
              id: i + 1,
              customer_id: 7,
              status: "Completed",
              date_created: "2026-01-15T00:00:00.000Z",
              date_modified: "2026-01-15T00:00:00.000Z",
              billing_address: {
                first_name: "Pat",
                last_name: "Lee",
                email: "pat.lee@example.com",
              },
            }));
            return new Response(JSON.stringify(orders), { status: 200 });
          }
          if (url.endsWith("/products")) {
            return new Response(
              JSON.stringify([
                { id: 1, product_id: 200, sku: "NON-MEMBERSHIP-SKU", name: "T-Shirt" },
              ]),
              { status: productsStatus },
            );
          }
          throw new Error(`Unexpected fetch() call in test: ${url}`);
        },
      );
    }

    it("acks a chain's last slice without enqueueing a follow-up", async () => {
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
      expect(sent).toEqual([]);
    });

    it("enqueues a follow-up carrying the continuation, then acks", async () => {
      mockFullPageOfMerchandise();
      const cursor = {
        chainStartedAt: Date.UTC(2026, 8, 1),
        modifiedSince: Date.UTC(2026, 7, 31),
        afterId: 0,
        messages: 4,
      };
      const message = makeMessage({ type: "sync_subscriptions_etl", cursor });

      await handleEtlSyncBatch(makeBatch([message]), env);

      expect(sent).toEqual([
        {
          type: "sync_subscriptions_etl",
          cursor: { ...cursor, afterId: ORDERS_PAGE_SIZE, messages: 5 },
        },
      ]);
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it("keeps loadAll on the follow-up of a new chain", async () => {
      mockFullPageOfMerchandise();
      const message = makeMessage({
        type: "sync_subscriptions_etl",
        loadAll: true,
      });

      await handleEtlSyncBatch(makeBatch([message]), env);

      expect(sent).toEqual([
        {
          type: "sync_subscriptions_etl",
          loadAll: true,
          cursor: {
            chainStartedAt: expect.any(Number),
            afterId: ORDERS_PAGE_SIZE,
            messages: 1,
          },
        },
      ]);
    });

    it("retries a failed slice without enqueueing a follow-up", async () => {
      mockFullPageOfMerchandise(500);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const message = makeMessage({
        type: "sync_subscriptions_etl",
        loadAll: true,
      });

      await handleEtlSyncBatch(makeBatch([message]), env);

      expect(sent).toEqual([]);
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
    });
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

  it("routes run_slack_members_etl to the Slack members ETL (skipped, but acked, with no bot token)", async () => {
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
