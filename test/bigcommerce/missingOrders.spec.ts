import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flagOrderMissingFromStore,
  syncBigCommerceOrder,
} from "../../src/bigcommerce/sync";
import { missingOrders } from "../../src/admin/reportQueries";

const STORE = "storehash";
const ORDER_ID = 4242;
const ORDER_KEY = "4242_bc";
const SLACK_WEBHOOK = "https://hooks.slack.example/T/B/X";

/**
 * A deleted order is the one case where BigCommerce's answer is a fact rather
 * than a failure, so these tests are mostly about what we *don't* do with it:
 * no retrying, no dead-lettering, and above all no quietly taking a
 * membership away (los-verdes/card-losverd-es#105).
 */

async function insertOrder(status: string | null = "Completed", missingSince: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name,
       status, created_on, expires_on, first_seen_via, missing_since)
     VALUES (?, 'bigcommerce', 'someone@example.com', 'someone@example.com', 'Test', 'Member',
       ?, '2025-06-01', '2026-06-01', 'sync', ?)`,
  )
    .bind(ORDER_KEY, status, missingSince)
    .run();
}

const slackPosts: string[] = [];

/** BigCommerce answers `orderStatus`; Slack accepts and records. */
function mockRemotes(orderStatus: number) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(SLACK_WEBHOOK)) {
      slackPosts.push(String(init?.body ?? ""));
      return new Response("ok");
    }
    if (url.includes("/v2/orders/")) {
      // `null`, not `""`: 204 is a null-body status, and constructing a
      // Response with a zero-length body for one makes workerd warn.
      return new Response(orderStatus === 200 ? "{}" : null, { status: orderStatus });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function storedMissingSince(): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT missing_since FROM membership_orders WHERE order_id = ?",
  )
    .bind(ORDER_KEY)
    .first<{ missing_since: number | null }>();
  return row?.missing_since ?? null;
}

beforeEach(() => {
  slackPosts.length = 0;
  env.BIGCOMMERCE_ACCESS_TOKEN = "token";
  env.SLACK_ALERT_WEBHOOK_URL = SLACK_WEBHOOK;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM membership_orders");
});

describe("flagOrderMissingFromStore", () => {
  it("records when the order was first missed", async () => {
    await insertOrder();
    mockRemotes(404);

    expect(await flagOrderMissingFromStore(env, ORDER_ID)).toBe("flagged");
    expect(await storedMissingSince()).toBeGreaterThan(0);
  });

  it("leaves the order counting towards membership", async () => {
    // The decision this implements: a missing order is raised for a person,
    // never withdrawn automatically.
    await insertOrder();
    mockRemotes(404);

    await flagOrderMissingFromStore(env, ORDER_ID);

    const [row] = await missingOrders(env.DB);
    expect(row.counts).toBe(1);
    expect(row.expires_on).toBe("2026-06-01");
  });

  it("raises it once, however often the webhook fires", async () => {
    await insertOrder();
    mockRemotes(404);

    expect(await flagOrderMissingFromStore(env, ORDER_ID)).toBe("flagged");
    const firstSeen = await storedMissingSince();
    expect(await flagOrderMissingFromStore(env, ORDER_ID)).toBe("already-flagged");

    expect(await storedMissingSince()).toBe(firstSeen);
    expect(slackPosts).toHaveLength(1);
  });

  it("says nothing about an order we never held", async () => {
    mockRemotes(404);
    expect(await flagOrderMissingFromStore(env, ORDER_ID)).toBe("not-ours");
    expect(slackPosts).toEqual([]);
  });

  it("keeps the order id and the member's address out of Slack", async () => {
    // Same rule as the dead-letter alert: a channel has a wider audience
    // than our own logs.
    await insertOrder();
    mockRemotes(404);

    await flagOrderMissingFromStore(env, ORDER_ID);

    expect(slackPosts[0]).not.toContain(ORDER_KEY);
    expect(slackPosts[0]).not.toContain("someone@example.com");
    expect(slackPosts[0]).toContain("still counts");
  });
});

describe("syncBigCommerceOrder, for an order the store no longer has", () => {
  it("flags it instead of throwing, so the message doesn't dead-letter", async () => {
    await insertOrder();
    mockRemotes(404);

    await expect(syncBigCommerceOrder(env, STORE, ORDER_ID)).resolves.toBeUndefined();
    expect(await storedMissingSince()).toBeGreaterThan(0);
  });

  it("treats a 204 the same way, since v2 uses it for an empty resource", async () => {
    await insertOrder();
    mockRemotes(204);

    await expect(syncBigCommerceOrder(env, STORE, ORDER_ID)).resolves.toBeUndefined();
    expect(await storedMissingSince()).toBeGreaterThan(0);
  });

  it("still throws on a real failure, which should be retried", async () => {
    // A 500 is not evidence the order is gone, so it must keep its retries
    // rather than being recorded as missing.
    await insertOrder();
    mockRemotes(500);

    await expect(syncBigCommerceOrder(env, STORE, ORDER_ID)).rejects.toThrow();
    expect(await storedMissingSince()).toBeNull();
  });
});

describe("the missing-orders report", () => {
  it("lists nothing when no order is missing", async () => {
    await insertOrder();
    expect(await missingOrders(env.DB)).toEqual([]);
  });

  it("puts the longest-unreviewed order first", async () => {
    await insertOrder("Completed", 2_000);
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name,
         status, created_on, expires_on, first_seen_via, missing_since)
       VALUES ('4243_bc', 'bigcommerce', 'other@example.com', 'other@example.com', 'Test', 'Member',
         'Completed', '2025-06-01', '2026-06-01', 'sync', 1000)`,
    ).run();

    expect((await missingOrders(env.DB)).map((row) => row.order_id)).toEqual([
      "4243_bc",
      ORDER_KEY,
    ]);
  });
});
