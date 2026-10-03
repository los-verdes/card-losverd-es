import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINIBC_API_BASE,
  MINIBC_JOB_NAME,
  MINIBC_MAX_PAGES_PER_SKU,
  MINIBC_PAGES_PER_MESSAGE,
  MinibcAuthError,
  MinibcClient,
  minibcDate,
  minibcTimestamp,
  subscriptionRow,
  syncMinibcSubscriptions,
  type MinibcCursor,
  type MinibcSubscription,
} from "../../src/minibc/subscriptions";

const PACK = "LOSV-MEM-0001";
const NO_MERCH = "LOSV-DIGI-5000";

/** A subscription shaped as MiniBC returns one (checked 2026-09-30), with synthetic values. */
function subscription(id: number, overrides: Partial<MinibcSubscription> & Record<string, unknown> = {}): MinibcSubscription {
  return {
    id,
    order_id: 1000 + id,
    status: "active",
    signup_date: "2025-02-14",
    next_payment_date: "2027-02-14",
    pause_date: "",
    cancellation_date: "",
    last_modified: "1790000000",
    created_time: "0",
    periodicity: { frequency: 1, unit: "month" },
    customer: { id: 900 + id, store_customer_id: 5000 + id, first_name: "Test", last_name: "Member", email: `member${id}@example.com` },
    payment_method: { id: 70 + id, method: "credit_card", credit_card: { type: "Visa", last_digits: "4242" } },
    shipping_address: { street_1: "1 Example St", city: "Austin" },
    products: [{ sku: "", name: "", store_product_id: 319 }],
    metadata: { legacy_cleanup: true },
    ...overrides,
  } as MinibcSubscription;
}

/**
 * MiniBC's search: `pages[sku]` is that SKU's pages, 404 past the last.
 * Records each request's SKU, page and headers.
 */
function mockMinibc(pages: Record<string, MinibcSubscription[][]>, respond?: (sku: string, page: number) => Response | undefined) {
  const requests: { sku: string; page: number; key: string | null; method: string; url: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as { product_sku: string; page: number };
    requests.push({ sku: body.product_sku, page: body.page, key: request.headers.get("X-MBC-TOKEN"), method: request.method, url: request.url });
    const override = respond?.(body.product_sku, body.page);
    if (override) return override;
    const list = pages[body.product_sku]?.[body.page - 1];
    return list ? Response.json(list) : Response.json({ error: "Not found" }, { status: 404 });
  });
  return requests;
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM minibc_subscriptions ORDER BY subscription_id").all<Record<string, unknown>>();
  return results;
}

/** Runs a whole read, following `next` as the queue would. */
async function readAll(): Promise<number> {
  let cursor: MinibcCursor | undefined;
  let messages = 0;
  do {
    const result = await syncMinibcSubscriptions(env, cursor, 0);
    cursor = result.next;
    messages++;
  } while (cursor);
  return messages;
}

beforeEach(() => {
  env.MINIBC_API_KEY = "test-minibc-key";
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MINIBC_API_KEY = undefined;
  await env.DB.exec("DELETE FROM minibc_subscriptions");
  await env.DB.exec("DELETE FROM etl_sync_state");
});

describe("reading MiniBC's membership subscriptions", () => {
  it("reads every page of every membership SKU, searching only, with the key", async () => {
    const requests = mockMinibc({
      [PACK]: [[subscription(1), subscription(2)], [subscription(3)]],
      [NO_MERCH]: [[subscription(4)]],
    });

    await readAll();

    expect(requests.map(({ sku, page }) => `${sku}#${page}`)).toEqual([`${PACK}#1`, `${PACK}#2`, `${PACK}#3`, `${NO_MERCH}#1`, `${NO_MERCH}#2`]);
    expect(requests.every((r) => r.method === "POST" && r.url === `${MINIBC_API_BASE}/subscriptions/search` && r.key === "test-minibc-key")).toBe(true);
    expect((await rows()).map((row) => [row.subscription_id, row.sku])).toEqual([
      [1, PACK],
      [2, PACK],
      [3, PACK],
      [4, NO_MERCH],
    ]);
  });

  it("keeps when and whether it renews, how to find its member, and its email as a hint, but no other personal detail", async () => {
    mockMinibc({ [PACK]: [[subscription(1)]] });

    await readAll();

    const [row] = await rows();
    expect(row).toMatchObject({
      subscription_id: 1,
      order_id: 1001,
      origin_order_id: null,
      store_customer_id: 5001,
      customer_email: "member1@example.com",
      status: "active",
      signup_on: "2025-02-14",
      next_payment_on: "2027-02-14",
      paused_on: null,
      cancelled_on: null,
      minibc_modified_at: 1790000000000,
      missing_since: null,
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        "subscription_id", "order_id", "origin_order_id", "store_customer_id", "customer_email", "sku", "status", "signup_on",
        "next_payment_on", "paused_on", "cancelled_on", "minibc_modified_at", "seen_at", "missing_since", "updated_at",
      ].sort(),
    );
    // The email is the one contact detail kept (#470): no names, card or address.
    const { customer_email: _email, ...rest } = row as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toMatch(/example\.com|Test|Member|Visa|4242|Example St/);
  });

  it("updates a subscription read again, as it is cancelled, say", async () => {
    mockMinibc({ [PACK]: [[subscription(1)]] });
    await readAll();
    vi.restoreAllMocks();
    mockMinibc({ [PACK]: [[subscription(1, { status: "inactive", next_payment_date: "", cancellation_date: "2026-09-01" })]] });

    await readAll();

    expect((await rows())[0]).toMatchObject({ status: "inactive", next_payment_on: null, cancelled_on: "2026-09-01" });
  });

  it("reads a set number of pages per message, and carries on where it stopped", async () => {
    const many = Array.from({ length: MINIBC_PAGES_PER_MESSAGE + 3 }, (_, i) => [subscription(i + 1)]);
    const requests = mockMinibc({ [PACK]: many });

    const first = await syncMinibcSubscriptions(env, undefined, 0);
    expect(first.next).toMatchObject({ skuIndex: 0, page: MINIBC_PAGES_PER_MESSAGE + 1 });
    expect(requests).toHaveLength(MINIBC_PAGES_PER_MESSAGE);
    expect(await env.DB.prepare("SELECT 1 FROM etl_sync_state WHERE job_name = ?").bind(MINIBC_JOB_NAME).first()).toBeNull();

    const second = await syncMinibcSubscriptions(env, first.next, 0);
    expect(second.next).toBeUndefined();
    expect(await rows()).toHaveLength(MINIBC_PAGES_PER_MESSAGE + 3);
    // Every subscription in the read carries the read's start, whichever message wrote it.
    expect(new Set((await rows()).map((row) => row.seen_at))).toEqual(new Set([first.next!.walkStartedAt]));
  });

  it("flags a subscription a complete read no longer lists, keeps it, and clears the flag once listed again", async () => {
    mockMinibc({ [PACK]: [[subscription(1), subscription(2)]] });
    await readAll();
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});

    mockMinibc({ [PACK]: [[subscription(1)]] });
    await readAll();
    const flagged = await rows();
    expect(flagged.find((row) => row.subscription_id === 2)?.missing_since).toEqual(expect.any(Number));
    expect(flagged.find((row) => row.subscription_id === 1)?.missing_since).toBeNull();

    vi.restoreAllMocks();
    mockMinibc({ [PACK]: [[subscription(1), subscription(2)]] });
    await readAll();
    expect((await rows()).every((row) => row.missing_since === null)).toBe(true);
  });

  it("records that it ran once a read is complete", async () => {
    mockMinibc({ [PACK]: [[subscription(1)]] });
    await readAll();

    const state = await env.DB.prepare("SELECT last_run_at, updated_at FROM etl_sync_state WHERE job_name = ?")
      .bind(MINIBC_JOB_NAME)
      .first<{ last_run_at: number; updated_at: number }>();
    expect(state?.updated_at).toBeGreaterThanOrEqual(state!.last_run_at);
  });

  it("does nothing without a key", async () => {
    env.MINIBC_API_KEY = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await syncMinibcSubscriptions(env)).toEqual({ read: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops rather than paging forever when MiniBC never says it has run out", async () => {
    mockMinibc({}, () => Response.json([subscription(1)]));
    const cursor: MinibcCursor = { walkStartedAt: Date.now(), skuIndex: 0, page: MINIBC_MAX_PAGES_PER_SKU + 1 };

    await expect(syncMinibcSubscriptions(env, cursor, 0)).rejects.toThrow(/more than 200 pages/);
  });

  it("skips anything without an id, and writes nothing for an empty page", async () => {
    mockMinibc({ [PACK]: [[subscription(1), { ...subscription(2), id: "x" as unknown as number }]] });
    await readAll();
    expect((await rows()).map((row) => row.subscription_id)).toEqual([1]);
  });
});

describe("MinibcClient", () => {
  const client = () => new MinibcClient("test-minibc-key", 0);

  it("tries again after a rate limit or a server error", async () => {
    let refusals = 2;
    mockMinibc({ [PACK]: [[subscription(1)]] }, () => (refusals-- > 0 ? new Response("busy", { status: refusals === 1 ? 429 : 502 }) : undefined));

    expect(await client().searchSubscriptions(PACK, 1)).toHaveLength(1);
  });

  it("gives up after a few tries", async () => {
    mockMinibc({}, () => new Response("down", { status: 503 }));
    await expect(client().searchSubscriptions(PACK, 1)).rejects.toThrow(/failed: 503 down/);
  });

  it("says plainly when MiniBC refuses the key", async () => {
    mockMinibc({}, () => new Response("no", { status: 401 }));
    await expect(client().searchSubscriptions(PACK, 1)).rejects.toBeInstanceOf(MinibcAuthError);
  });

  it("treats an empty list like the end, and refuses anything that isn't a list", async () => {
    mockMinibc({ [PACK]: [[]] });
    expect(await client().searchSubscriptions(PACK, 1)).toBeNull();

    vi.restoreAllMocks();
    mockMinibc({}, () => Response.json({ error: "odd" }));
    await expect(client().searchSubscriptions(PACK, 1)).rejects.toThrow(/other than a list/);
  });
});

describe("MiniBC's values", () => {
  it.each([
    ["2027-02-14", "2027-02-14"],
    ["2027-02-14 00:00:00", "2027-02-14"],
    ["", null],
    ["0", null],
    ["-0001-11-30", null],
    ["0000-00-00", null],
    ["2027-00-14", null],
    [null, null],
    [20270214, null],
  ])("reads the date %j as %j", (value, expected) => {
    expect(minibcDate(value)).toBe(expected);
  });

  it("reads last_modified as epoch seconds", () => {
    expect(minibcTimestamp("1790000000")).toBe(1790000000000);
    expect(minibcTimestamp("0")).toBeNull();
    expect(minibcTimestamp("")).toBeNull();
    expect(minibcTimestamp(undefined)).toBeNull();
  });

  it("takes origin_order_id from metadata when MiniBC recorded one, and copes with odd metadata", () => {
    expect(subscriptionRow(subscription(1, { metadata: { origin_order_id: "4321" } })).origin_order_id).toBe(4321);
    expect(subscriptionRow(subscription(1, { metadata: [] })).origin_order_id).toBeNull();
    expect(subscriptionRow(subscription(1, { metadata: null })).origin_order_id).toBeNull();
    expect(subscriptionRow(subscription(1, { status: "" })).status).toBe("unknown");
    expect(subscriptionRow(subscription(1, { customer: undefined })).store_customer_id).toBeNull();
    // The customer's email, lowercased, kept only to hint at a member (#470).
    expect(subscriptionRow(subscription(1, { customer: { store_customer_id: 0, email: " Member1@Example.COM " } })).customer_email).toBe("member1@example.com");
    expect(subscriptionRow(subscription(1, { customer: { store_customer_id: 0, email: "" } })).customer_email).toBeNull();
    expect(subscriptionRow(subscription(1, { customer: undefined })).customer_email).toBeNull();
  });
});
