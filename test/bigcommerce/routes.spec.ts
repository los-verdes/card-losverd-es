import "../setup/d1";
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookAuthorization } from "../../src/bigcommerce/routes";
import { isValidOrderId } from "../../src/bigcommerce/routes";
import { signWebhookToken } from "../../src/bigcommerce/webhookToken";
import type { EtlSyncMessage } from "../../src/queues/etlSync";

// The route validates the webhook's `producer` field against
// `env.BIGCOMMERCE_STORE_HASH` (set from wrangler.toml's `[vars]` in this
// test environment), so the default payload must match that, not an
// arbitrary constant.
function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: { type: "order", id: 555 },
    hash: "deadbeef",
    producer: `stores/${env.BIGCOMMERCE_STORE_HASH}`,
    scope: "store/order/*",
    store_id: "999",
    ...overrides,
  };
}

// Not in wrangler.toml (it's a secret), so tests supply their own.
beforeEach(() => {
  env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY = "test-webhook-signing-key";
});

async function validAuthHeader(): Promise<string> {
  const token = await signWebhookToken(
    env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY,
    env.BIGCOMMERCE_STORE_HASH,
    env.BIGCOMMERCE_CLIENT_ID,
  );
  return `bearer ${token}`;
}

const PURE_FN_TEST_STORE_HASH = "store123";

describe("signWebhookToken / verifyWebhookAuthorization", () => {
  it("matches an independently computed token (the value scripts/bigcommerce-webhook.mjs registers)", async () => {
    // printf 'abc123store.synthetic-client-id' | openssl dgst -sha256 -hmac synthetic-key-123 -binary | base64
    expect(await signWebhookToken("synthetic-key-123", "abc123store", "synthetic-client-id")).toBe(
      "NoZNOiN8pfIT1m0ZpBPPzxhgS6BciLr4cOg1VxgsfK0=",
    );
  });

  it("verifies a token signed with the same key/store/client", async () => {
    const token = await signWebhookToken(
      "test-signing-key",
      PURE_FN_TEST_STORE_HASH,
      "client-abc",
    );
    expect(verifyWebhookAuthorization(`bearer ${token}`, token)).toBe(true);
    // Matches the Python app's case-insensitive `Authorization` handling.
    expect(verifyWebhookAuthorization(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects a token signed with a different key", async () => {
    const token = await signWebhookToken(
      "test-signing-key",
      PURE_FN_TEST_STORE_HASH,
      "client-abc",
    );
    const wrongToken = await signWebhookToken(
      "different-key",
      PURE_FN_TEST_STORE_HASH,
      "client-abc",
    );
    expect(verifyWebhookAuthorization(`bearer ${wrongToken}`, token)).toBe(
      false,
    );
  });

  it("rejects a missing Authorization header", () => {
    expect(verifyWebhookAuthorization(null, "expected-token")).toBe(false);
    expect(verifyWebhookAuthorization(undefined, "expected-token")).toBe(false);
  });

  it("rejects a token of a different length without throwing (constant-time compare's length guard)", async () => {
    const token = await signWebhookToken(
      "test-signing-key",
      PURE_FN_TEST_STORE_HASH,
      "client-abc",
    );
    expect(verifyWebhookAuthorization(`bearer ${token}extra`, token)).toBe(
      false,
    );
  });
});

describe("missing BIGCOMMERCE_WEBHOOK_SIGNING_KEY", () => {
  it("refuses to sign rather than using an empty (forgeable) key", async () => {
    await expect(signWebhookToken("", "store123", "client")).rejects.toThrow(
      /BIGCOMMERCE_WEBHOOK_SIGNING_KEY is not configured/,
    );
  });

  it("makes the webhook fail closed", async () => {
    env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY = "";
    const res = await SELF.fetch("https://example.com/bigcommerce/order-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "bearer anything" },
      body: JSON.stringify(webhookPayload()),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /bigcommerce/order-webhook", () => {
  const realQueue = env.ETL_SYNC_QUEUE;

  afterEach(() => {
    vi.restoreAllMocks();
    env.ETL_SYNC_QUEUE = realQueue;
  });

  it("rejects an invalid JSON body", async () => {
    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a payload missing required fields", async () => {
    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { type: "order" } }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a payload for an unconfigured store_hash", async () => {
    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          webhookPayload({ producer: "stores/some-other-store" }),
        ),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request with no/invalid Authorization header", async () => {
    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookPayload()),
      },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a validly-signed order webhook and enqueues sync_bigcommerce_order", async () => {
    const sent: EtlSyncMessage[] = [];
    (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
      send: async (message: EtlSyncMessage) => {
        sent.push(message);
      },
    } as unknown as Queue<EtlSyncMessage>;

    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await validAuthHeader(),
        },
        body: JSON.stringify(webhookPayload()),
      },
    );

    expect(res.status).toBe(200);
    expect(sent).toEqual([
      {
        type: "sync_bigcommerce_order",
        orderId: "555",
        storeHash: env.BIGCOMMERCE_STORE_HASH,
      },
    ]);
  });

  it("acks non-order webhook types without enqueueing anything", async () => {
    const sent: EtlSyncMessage[] = [];
    (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
      send: async (message: EtlSyncMessage) => {
        sent.push(message);
      },
    } as unknown as Queue<EtlSyncMessage>;

    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await validAuthHeader(),
        },
        body: JSON.stringify(
          webhookPayload({ data: { type: "customer", id: 1 } }),
        ),
      },
    );

    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  // The id is interpolated into a BigCommerce API path, and a URL normalises
  // `..` away rather than rejecting it, so an id carrying dot segments would
  // address a different endpoint with this store's token attached. Reaching
  // this needs the webhook token, so it is a second lock -- but a cheap one.
  it.each([
    ["dot segments", "../../v2/customers"],
    ["a query string", "1?include=x"],
    ["a path separator", "1/products"],
    ["not a number", "abc"],
    ["zero", 0],
    ["a negative number", -1],
    ["empty", ""],
  ])("refuses an order id with %s, without enqueueing", async (_label, id) => {
    const sent: EtlSyncMessage[] = [];
    (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
      send: async (message: EtlSyncMessage) => {
        sent.push(message);
      },
    } as unknown as Queue<EtlSyncMessage>;

    const res = await SELF.fetch(
      "https://example.com/bigcommerce/order-webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await validAuthHeader(),
        },
        body: JSON.stringify(webhookPayload({ data: { type: "order", id } })),
      },
    );

    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("still accepts an ordinary numeric order id, as a string or a number", async () => {
    expect(isValidOrderId(1001)).toBe(true);
    expect(isValidOrderId("1001")).toBe(true);
  });

});
