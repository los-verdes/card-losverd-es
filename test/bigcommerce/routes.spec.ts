import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signWebhookToken,
  verifyWebhookAuthorization,
} from "../../src/bigcommerce/routes";
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
});

describe("POST /bigcommerce/order-webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (env as { ETL_SYNC_QUEUE?: unknown }).ETL_SYNC_QUEUE;
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

  it("still returns 200 when ETL_SYNC_QUEUE isn't configured yet (Phase 2.5.2 not wired up)", async () => {
    // No env.ETL_SYNC_QUEUE set here - matches this repo's current
    // wrangler.toml, which has no queue binding declared yet.
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
  });
});
