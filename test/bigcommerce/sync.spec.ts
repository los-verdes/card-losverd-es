import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { membershipExpiry, toIsoSeconds } from "../../src/bigcommerce/orders";
import { fakeEmailBinding, type FakeEmailBinding } from "../fixtures/emailBinding";
import {
  BigCommerceAuthError,
  BigCommerceClient,
  MAX_CHAIN_MESSAGES,
  MAX_UNLISTED_RECHECKS_PER_MESSAGE,
  MAX_MEMBERSHIP_ORDERS_PER_MESSAGE,
  ORDERS_PAGE_SIZE,
  countMembershipUnits,
  deriveMembershipState,
  refreshMemberFromOrders,
  syncBigCommerceOrder,
  syncCustomersEtl,
  syncMinibcSubscriptionsEtl,
  recheckUnlistedOrders,
  syncSubscriptionsEtl,
  type BigCommerceOrder,
  type BigCommerceOrderProduct,
  type CountedMembershipOrder,
  type SubscriptionsEtlCursor,
} from "../../src/bigcommerce/sync";

interface MemberRow {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  expiration_date: string | null;
  member_since: string | null;
  auth_token: string;
  last_updated_at: number;
}

async function getMemberByEmail(email: string): Promise<MemberRow | null> {
  return env.DB.prepare("SELECT * FROM members WHERE email = ?")
    .bind(email)
    .first<MemberRow>();
}

// Stated, not inherited: wrangler.toml sets this per environment, and these
// are tests of the sync rather than of the email a completed order sends,
// which test/email/newOrder.spec.ts covers.
beforeEach(() => {
  env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
});

async function countMembers(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM members",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

/** New members get a random id (#66). */
const MEMBER_ID_PATTERN = /^LV-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function memberIdFor(email: string): Promise<string> {
  return (await getMemberByEmail(email))!.member_id;
}

async function clearMembershipTables() {
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
}

function makeOrder(
  overrides: Partial<BigCommerceOrder> = {},
): BigCommerceOrder {
  return {
    id: 1001,
    customer_id: 42,
    status: "Completed",
    date_created: "2026-01-15T00:00:00.000Z",
    date_modified: "2026-01-15T00:00:00.000Z",
    billing_address: {
      first_name: "Jane",
      last_name: "Doe",
      email: "Jane.Doe@Example.com",
    },
    ...overrides,
  };
}

function makeProducts(
  overrides: Partial<BigCommerceOrderProduct>[] = [],
): BigCommerceOrderProduct[] {
  if (overrides.length > 0) {
    return overrides.map((o, i) => ({
      id: i + 1,
      product_id: 100 + i,
      sku: "LOSV-MEM-0001",
      name: "Los Verdes Annual Membership",
      ...o,
    }));
  }
  return [
    {
      id: 1,
      product_id: 100,
      sku: "LOSV-MEM-0001",
      name: "Los Verdes Annual Membership",
    },
  ];
}

function mockBigCommerceOrderFetch(
  order: BigCommerceOrder,
  products: BigCommerceOrderProduct[],
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/orders/${order.id}/products`)) {
        return new Response(JSON.stringify(products), { status: 200 });
      }
      if (url.endsWith(`/orders/${order.id}`)) {
        return new Response(JSON.stringify(order), { status: 200 });
      }
      throw new Error(`Unexpected fetch() call in test: ${url}`);
    });
}

interface HistoryOrder {
  orderId: string;
  /** `YYYY-MM-DD`; the membership runs 365 days from it. */
  createdOn: string;
  email?: string;
  status?: string | null;
  source?: "bigcommerce" | "squarespace";
  /** The stored verdict of an imported Squarespace-era row; 1 unless given. */
  counted?: 0 | 1;
  sku?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** A `membership_orders` row, as the sync or the legacy import would write it. */
async function insertHistoryOrder(order: HistoryOrder) {
  const createdOn = new Date(`${order.createdOn}T00:00:00Z`);
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name, sku, status, created_on, expires_on, first_seen_via, frozen_counts)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'sync', ?10)`,
  )
    .bind(
      order.orderId,
      order.source ?? "bigcommerce",
      order.email ?? "jane.doe@example.com",
      order.firstName === undefined ? "Jane" : order.firstName,
      order.lastName === undefined ? "Doe" : order.lastName,
      order.sku === undefined ? "LOSV-MEM-0001" : order.sku,
      order.status === undefined ? "Completed" : order.status,
      toIsoSeconds(createdOn),
      toIsoSeconds(membershipExpiry(createdOn)),
      order.source === "squarespace" ? (order.counted ?? 1) : null,
    )
    .run();
}

async function setOrderStatus(orderId: string, status: string) {
  await env.DB.prepare("UPDATE membership_orders SET status = ? WHERE order_id = ?")
    .bind(status, orderId)
    .run();
}

describe("deriveMembershipState", () => {
  function counted(
    createdOn: string,
    overrides: Partial<CountedMembershipOrder> = {},
  ): CountedMembershipOrder {
    const created = new Date(`${createdOn}T00:00:00Z`);
    return {
      created_on: toIsoSeconds(created),
      expires_on: toIsoSeconds(membershipExpiry(created)),
      sku: "LOSV-MEM-0001",
      first_name: "Jane",
      last_name: "Doe",
      ...overrides,
    };
  }

  it("has no dates or name when no order counts", () => {
    expect(deriveMembershipState([])).toEqual({
      expirationDate: null,
      memberSince: null,
      firstName: null,
      lastName: null,
    });
  });

  it("takes a single order's dates and billing name", () => {
    expect(deriveMembershipState([counted("2026-01-15")])).toEqual({
      expirationDate: "2027-01-15",
      memberSince: "2026-01-15",
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("uses the earliest order for member_since and the latest expiry, whatever order the rows come in", () => {
    const state = deriveMembershipState(
      [counted("2025-01-15"), counted("2016-03-01"), counted("2026-01-15"), counted("2020-06-01")]
    );
    expect(state.memberSince).toBe("2016-03-01");
    expect(state.expirationDate).toBe("2027-01-15");
  });

  it("takes the name from the latest order", () => {
    const state = deriveMembershipState(
      [
        counted("2026-01-15", { last_name: "Doe-Smith" }),
        counted("2025-01-15", { first_name: "Janet" }),
      ]
    );
    expect(state.firstName).toBe("Jane");
    expect(state.lastName).toBe("Doe-Smith");
  });

  it("keeps the latest order's expiry even once it has passed, leaving \"expired\" to whoever asks", () => {
    const state = deriveMembershipState([counted("2024-01-15"), counted("2025-01-15")]);
    expect(state.expirationDate).toBe("2026-01-15");
  });

  it("leaves the name null when the latest order doesn't say (e.g. a Squarespace-era row)", () => {
    const state = deriveMembershipState(
      [counted("2016-03-01", { sku: null, first_name: null, last_name: "" }), counted("2015-03-01", { sku: "SQ-UNKNOWN" })]
    );
    expect(state.firstName).toBeNull();
    expect(state.lastName).toBeNull();
  });
});

describe("refreshMemberFromOrders", () => {
  const fallback = {
    firstName: "Fallback",
    lastName: "Name",
  };

  afterEach(clearMembershipTables);

  async function insertMember(
    memberId: string,
    email: string,
    fields: Partial<{
      firstName: string;
      expirationDate: string | null;
      memberSince: string | null;
    }> = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
       VALUES (?, ?, 'Doe', ?, ?, ?, 'pre-existing-token', ?)`,
    )
      .bind(
        memberId,
        fields.firstName ?? "Jane",
        email,
        fields.expirationDate === undefined ? "2099-01-15" : fields.expirationDate,
        fields.memberSince === undefined ? "2098-01-15" : fields.memberSince,
        Date.now(),
      )
      .run();
  }

  it("inserts a new member derived from their counted orders", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2090-01-15" });
    await insertHistoryOrder({ orderId: "2", createdOn: "2098-01-15", lastName: "Doe-Smith" });

    const result = await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
    expect(result).toEqual({ memberId: expect.stringMatching(MEMBER_ID_PATTERN), passChanged: true });

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member).toMatchObject({
      member_id: result?.memberId,
      first_name: "Jane",
      last_name: "Doe-Smith",
      expiration_date: "2099-01-15",
      member_since: "2090-01-15",
    });
    expect(member?.auth_token).toBeTruthy();
  });

  it("is idempotent: one row, the same auth_token, and no change reported the second time", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
    const first = await getMemberByEmail("jane.doe@example.com");
    const second = await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    expect(second).toEqual({ memberId: first?.member_id, passChanged: false });
    expect(await countMembers()).toBe(1);
    expect((await getMemberByEmail("jane.doe@example.com"))?.auth_token).toBe(first?.auth_token);
  });

  it("preserves an existing member_id and auth_token when matched by email", async () => {
    await insertMember("LV-10023", "jane.doe@example.com", { expirationDate: "2026-06-01" });
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    expect(await countMembers()).toBe(1);
    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.member_id).toBe("LV-10023");
    expect(member?.auth_token).toBe("pre-existing-token");
    expect(member?.expiration_date).toBe("2099-01-15");
  });

  it("lower-cases and trims the email it is given", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    await refreshMemberFromOrders(env, " Jane.Doe@EXAMPLE.com ", fallback);

    expect(await getMemberByEmail("jane.doe@example.com")).not.toBeNull();
  });

  it("leaves out refunded, cancelled, and declined orders", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2090-01-15" });
    await insertHistoryOrder({ orderId: "2", createdOn: "2080-01-15", status: "Declined" });
    await insertHistoryOrder({ orderId: "3", createdOn: "2095-01-15", status: "Refunded" });
    await insertHistoryOrder({ orderId: "4", createdOn: "2096-01-15", status: "Cancelled" });
    await insertHistoryOrder({ orderId: "sq-5", createdOn: "2097-01-15", status: "CANCELED", source: "squarespace", counted: 0 });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.member_since).toBe("2090-01-15");
    expect(member?.expiration_date).toBe("2091-01-15");
  });

  // Decided 2026-09-17: an unpaid BigCommerce order gets no card.
  it.each([
    ["Awaiting Fulfillment", "2099-01-15"],
    ["Awaiting Shipment", "2099-01-15"],
    ["Completed", "2099-01-15"],
    ["Shipped", "2099-01-15"],
    ["Incomplete", null],
    ["Pending", null],
    ["Awaiting Payment", null],
    ["Partially Refunded", null],
    ["Disputed", null],
  ])("a BigCommerce %s order gives an expiration of %s", async (status, expiration) => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15", status });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date ?? null).toBe(expiration);
  });

  // An imported order counts by the verdict stored with it, never by
  // reading its status through BigCommerce's vocabulary: Squarespace's
  // PENDING meant paid.
  it.each([
    ["PENDING", 1, "2099-01-15"],
    [null, 1, "2099-01-15"],
    ["CANCELED", 0, null],
    ["Completed", 0, null],
  ] as const)("an imported %s order with verdict %i gives an expiration of %s", async (status, counted, expiration) => {
    await insertHistoryOrder({ orderId: "sq-1", createdOn: "2098-01-15", source: "squarespace", status, counted });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date ?? null).toBe(expiration);
  });

  it("rolls a synced renewal back once it is refunded", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2097-01-15" });
    await insertHistoryOrder({ orderId: "2", createdOn: "2098-01-15" });
    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date).toBe("2099-01-15");

    await setOrderStatus("2", "Refunded");

    expect((await refreshMemberFromOrders(env, "jane.doe@example.com", fallback))?.passChanged).toBe(true);
    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date).toBe("2098-01-15");
  });

  it("keeps a member whose every order stopped counting, with no current membership", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });
    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
    const before = await getMemberByEmail("jane.doe@example.com");

    await setOrderStatus("1", "Refunded");

    expect(await refreshMemberFromOrders(env, "jane.doe@example.com", fallback)).toEqual({
      memberId: before?.member_id,
      passChanged: true,
    });
    expect(await getMemberByEmail("jane.doe@example.com")).toMatchObject({
      member_id: before?.member_id,
      auth_token: before?.auth_token,
      first_name: "Jane",
      expiration_date: null,
      member_since: null,
    });
  });

  it("creates nothing for an email with no counted orders", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15", status: "Refunded" });

    expect(await refreshMemberFromOrders(env, "jane.doe@example.com", fallback)).toBeNull();
    expect(await countMembers()).toBe(0);
  });

  it("counts a Squarespace-era order toward member_since", async () => {
    await insertHistoryOrder({ orderId: "sq-1", createdOn: "2016-03-01", source: "squarespace", sku: null, firstName: null, lastName: null });
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.member_since).toBe("2016-03-01");
    expect(member?.first_name).toBe("Jane");
  });

  it("keeps the stored name when the latest order doesn't say", async () => {
    await insertMember("LV-10023", "jane.doe@example.com", { firstName: "Janet" });
    await insertHistoryOrder({ orderId: "sq-1", createdOn: "2098-01-15", source: "squarespace", sku: null, firstName: null, lastName: null });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.first_name).toBe("Janet");
  });

  it("uses the synced order's name for a new member when the history doesn't say", async () => {
    await insertHistoryOrder({ orderId: "sq-1", createdOn: "2098-01-15", source: "squarespace", sku: null, firstName: null, lastName: null });

    await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);

    expect(await getMemberByEmail("jane.doe@example.com")).toMatchObject({
      first_name: "Fallback",
      last_name: "Name",
    });
  });

  it("gives each new member their own id, even when their orders share a BigCommerce customer id", async () => {
    // Guest checkouts all have customer_id 0, and a gifted order carries the
    // buyer's; neither may make two people share a pass serial (#66).
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });
    await insertHistoryOrder({ orderId: "2", createdOn: "2098-02-15", email: "gift.recipient@example.com" });

    const buyer = await refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
    const recipient = await refreshMemberFromOrders(env, "gift.recipient@example.com", fallback);

    expect(await countMembers()).toBe(2);
    expect(buyer?.memberId).toEqual(expect.stringMatching(MEMBER_ID_PATTERN));
    expect(recipient?.memberId).toEqual(expect.stringMatching(MEMBER_ID_PATTERN));
    expect(recipient?.memberId).not.toBe(buyer?.memberId);
    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date).toBe("2099-01-15");
  });

  it("converges on one row when two refreshes of the same new member overlap", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    const results = await Promise.all([
      refreshMemberFromOrders(env, "jane.doe@example.com", fallback),
      refreshMemberFromOrders(env, "jane.doe@example.com", fallback),
    ]);

    expect(await countMembers()).toBe(1);
    const memberId = await memberIdFor("jane.doe@example.com");
    expect(results.map((r) => r?.memberId)).toEqual([memberId, memberId]);
  });
});

describe("BigCommerceClient", () => {
  const client = new BigCommerceClient("store123", "test-access-token");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getOrder throws with status + body on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server exploded", { status: 500 }),
    );
    await expect(client.getOrderIfPresent(1)).rejects.toThrow(/500/);
  });

  it("getOrderProducts returns [] on a 204 (BigCommerce's empty-line-items response)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    await expect(client.getOrderProducts(1)).resolves.toEqual([]);
  });

  it("getOrderProducts throws with status + body on a non-ok, non-204 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    await expect(client.getOrderProducts(1)).rejects.toThrow(/403/);
  });

  it("listOrdersPage returns [] on a 204 (nothing matches)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    await expect(client.listOrdersPage(1)).resolves.toEqual([]);
  });

  it("listOrdersPage throws with status + body on a non-ok, non-204 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", { status: 502 }),
    );
    await expect(client.listOrdersPage(1)).rejects.toThrow(/502/);
  });

  it("listOrdersPage requests a max-size page by ascending id from min_id, with no extra filters by default", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === "string" ? input : input.toString();
        return new Response(null, { status: 204 });
      },
    );

    await client.listOrdersPage(3000);

    const params = new URL(requestedUrl).searchParams;
    expect(params.get("min_id")).toBe("3000");
    expect(params.get("sort")).toBe("id:asc");
    expect(params.get("limit")).toBe(String(ORDERS_PAGE_SIZE));
    expect(params.get("page")).toBeNull();
    expect(params.get("min_date_modified")).toBeNull();
  });

  it("waits out a 429 for X-Rate-Limit-Time-Reset-Ms, then retries", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "X-Rate-Limit-Time-Reset-Ms": "1" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(makeOrder()), { status: 200 }));

    await expect(client.getOrderIfPresent(1001)).resolves.toMatchObject({ id: 1001 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("waits a full rate-limit window on a 429 without a reset header", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = client.getOrderProducts(1001);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after repeated 429s and surfaces the error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "X-Rate-Limit-Time-Reset-Ms": "1" },
        }),
    );

    await expect(client.listOrdersPage(0)).rejects.toThrow(/429/);
    expect(fetchSpy).toHaveBeenCalledTimes(6); // the first try + 5 waits
  });
});

describe("syncBigCommerceOrder", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMembershipTables();
  });

  it("fetches the order + products and upserts a members row", async () => {
    const order = makeOrder();
    const products = makeProducts();
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member).not.toBeNull();
    expect(member?.member_id).toEqual(expect.stringMatching(MEMBER_ID_PATTERN));
    // order.date_created (2026-01-15) + 365 days
    expect(member?.expiration_date).toBe("2027-01-15");
    expect(member?.member_since).toBe("2026-01-15");
  });

  it("running the same order sync twice is idempotent (no duplicate rows)", async () => {
    const order = makeOrder();
    const products = makeProducts();
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);
    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await countMembers()).toBe(1);
  });

  it("skips orders with no membership SKU in their line items", async () => {
    const order = makeOrder({ id: 2002 });
    const products = makeProducts([{ sku: "SOME-OTHER-SKU", name: "T-Shirt" }]);
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await countMembers()).toBe(0);
  });

  it("records the expiry of an order whose one-year membership period has already lapsed", async () => {
    const order = makeOrder({ id: 3003, date_created: "2020-01-01T00:00:00.000Z" });
    const products = makeProducts();
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);

    const member = await getMemberByEmail("jane.doe@example.com");
    // 2020 is a leap year, so +365 days from Jan 1 lands on Dec 31, not Jan 1.
    expect(member?.expiration_date).toBe("2020-12-31");
  });

  it("doesn't create a member from an order that was refunded before it first synced", async () => {
    const order = makeOrder({ status: "Refunded" });
    mockBigCommerceOrderFetch(order, makeProducts());

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await countMembers()).toBe(0);
  });

  it("updates the member recorded on the order, even when that isn't the billing email", async () => {
    // An order already attributed to someone else (e.g. by the legacy import).
    await insertHistoryOrder({ orderId: "1001", createdOn: "2098-01-15", email: "gift.recipient@example.com" });
    const order = makeOrder({ date_created: "2098-01-15T00:00:00.000Z" });
    mockBigCommerceOrderFetch(order, makeProducts());

    await syncBigCommerceOrder(env, "store123", order.id);

    expect((await getMemberByEmail("gift.recipient@example.com"))?.expiration_date).toBe("2099-01-15");
    expect(await getMemberByEmail("jane.doe@example.com")).toBeNull();
  });
});

describe("syncSubscriptionsEtl", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    env.BIGCOMMERCE_STORE_HASH = "store123";
    // notifyPassUpdated()'s "APNs not configured" warning, once per new member.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.exec("DELETE FROM membership_orders");
    await env.DB.exec("DELETE FROM members");
    await env.DB.exec("DELETE FROM etl_sync_state");
  });

  async function readWatermark(): Promise<number | null> {
    const row = await env.DB.prepare(
      "SELECT last_run_at FROM etl_sync_state WHERE job_name = 'sync_subscriptions_etl'",
    ).first<{ last_run_at: number }>();
    return row?.last_run_at ?? null;
  }

  async function storeWatermark(lastRunAt: number): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)",
    )
      .bind("sync_subscriptions_etl", lastRunAt, lastRunAt)
      .run();
  }

  const merchandise = () =>
    makeProducts([{ sku: "NON-MEMBERSHIP-SKU", name: "T-Shirt" }]);

  function ordersWithIds(firstId: number, count: number): BigCommerceOrder[] {
    return Array.from({ length: count }, (_, i) => makeOrder({ id: firstId + i }));
  }

  /**
   * Mocks the orders list (answered by `listOrders` from the request's query
   * params; an empty answer is BigCommerce's 204) and each order's products,
   * recording what was requested.
   */
  function mockOrdersApi(
    listOrders: (params: URLSearchParams) => BigCommerceOrder[],
    productsFor: (orderId: number) => BigCommerceOrderProduct[] = () =>
      makeProducts(),
  ) {
    const requests = {
      list: [] as URLSearchParams[],
      productsForOrderIds: [] as number[],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          const params = new URL(url).searchParams;
          requests.list.push(params);
          const orders = listOrders(params);
          return orders.length > 0
            ? new Response(JSON.stringify(orders), { status: 200 })
            : new Response(null, { status: 204 });
        }
        const productsMatch = url.match(/\/orders\/(\d+)\/products$/);
        if (productsMatch) {
          const orderId = Number(productsMatch[1]);
          requests.productsForOrderIds.push(orderId);
          return new Response(JSON.stringify(productsFor(orderId)), {
            status: 200,
          });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );
    return requests;
  }

  it("finishes a chain on a short page: upserts membership orders and sets the watermark to the chain's start", async () => {
    const orderA = makeOrder({ id: 1, customer_id: 1 });
    const orderB = makeOrder({
      id: 2,
      customer_id: 2,
      billing_address: {
        first_name: "Bo",
        last_name: "Jones",
        email: "bo.jones@example.com",
      },
    });
    const requests = mockOrdersApi(() => [orderA, orderB]);

    const before = Date.now();
    const result = await syncSubscriptionsEtl(env, { loadAll: true });
    const after = Date.now();

    expect(result).toEqual({
      ordersProcessed: 2,
      recheckUnlisted: { since: expect.any(Number), afterId: 0, reread: 0, flagged: 0 },
    });
    expect(await countMembers()).toBe(2);
    expect(await getMemberByEmail("jane.doe@example.com")).not.toBeNull();
    expect(await getMemberByEmail("bo.jones@example.com")).not.toBeNull();
    // A new loadAll chain: from the first order id, no modified-since filter.
    expect(requests.list).toHaveLength(1);
    expect(requests.list[0].get("min_id")).toBe("0");
    expect(requests.list[0].get("min_date_modified")).toBeNull();

    const watermark = await readWatermark();
    expect(watermark).toBeGreaterThanOrEqual(before);
    expect(watermark).toBeLessThanOrEqual(after);
  });

  it("running the full resync twice is idempotent (no duplicate members)", async () => {
    const order = makeOrder();
    mockOrdersApi(() => [order]);

    await syncSubscriptionsEtl(env, { loadAll: true });
    await syncSubscriptionsEtl(env, { loadAll: true });

    expect(await countMembers()).toBe(1);
  });

  it("returns a continuation, and leaves the watermark alone, after a full page", async () => {
    const requests = mockOrdersApi(
      () => ordersWithIds(1, ORDERS_PAGE_SIZE),
      merchandise,
    );

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(result).toEqual({
      ordersProcessed: 0,
      next: {
        chainStartedAt: expect.any(Number),
        afterId: ORDERS_PAGE_SIZE,
        messages: 1,
        ordersRead: 0,
        cardsChanged: 0,
      },
    });
    expect(result.next).not.toHaveProperty("modifiedSince");
    expect(requests.productsForOrderIds).toHaveLength(ORDERS_PAGE_SIZE);
    expect(await readWatermark()).toBeNull();
  });

  it("resumes from the cursor, skipping the boundary order min_id returns again, and completes the chain", async () => {
    const olderWatermark = Date.UTC(2026, 7, 1);
    await storeWatermark(olderWatermark);
    const cursor: SubscriptionsEtlCursor = {
      chainStartedAt: Date.UTC(2026, 8, 1),
      afterId: 250,
      messages: 1,
    };
    const requests = mockOrdersApi(() => [
      makeOrder({ id: 250 }),
      makeOrder({ id: 251 }),
    ]);

    const result = await syncSubscriptionsEtl(env, { loadAll: true, cursor });

    expect(requests.list[0].get("min_id")).toBe("250");
    expect(requests.productsForOrderIds).toEqual([251]);
    expect(result).toEqual({
      ordersProcessed: 1,
      recheckUnlisted: { since: cursor.chainStartedAt, afterId: 0, reread: 0, flagged: 0 },
    });
    expect(await readWatermark()).toBe(cursor.chainStartedAt);
  });

  it("completes a chain whose last page was exactly full on the next, empty, page", async () => {
    const cursor: SubscriptionsEtlCursor = {
      chainStartedAt: Date.UTC(2026, 8, 1),
      afterId: 500,
      messages: 2,
    };
    mockOrdersApi(() => []);

    const result = await syncSubscriptionsEtl(env, { cursor });

    expect(result).toEqual({
      ordersProcessed: 0,
      recheckUnlisted: { since: cursor.chainStartedAt, afterId: 0, reread: 0, flagged: 0 },
    });
    expect(await readWatermark()).toBe(cursor.chainStartedAt);
  });

  it("never moves the watermark backwards (a later-started chain already finished)", async () => {
    const newerWatermark = Date.UTC(2026, 8, 10);
    await storeWatermark(newerWatermark);
    mockOrdersApi(() => []);

    await syncSubscriptionsEtl(env, {
      cursor: { chainStartedAt: Date.UTC(2026, 8, 1), afterId: 0, messages: 3 },
    });

    expect(await readWatermark()).toBe(newerWatermark);
  });

  it(`ends a slice mid-page after MAX_MEMBERSHIP_ORDERS_PER_MESSAGE (${MAX_MEMBERSHIP_ORDERS_PER_MESSAGE}) membership orders`, async () => {
    const requests = mockOrdersApi(() => ordersWithIds(1, ORDERS_PAGE_SIZE));

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(result.ordersProcessed).toBe(MAX_MEMBERSHIP_ORDERS_PER_MESSAGE);
    expect(requests.productsForOrderIds).toHaveLength(
      MAX_MEMBERSHIP_ORDERS_PER_MESSAGE,
    );
    expect(result.next?.afterId).toBe(MAX_MEMBERSHIP_ORDERS_PER_MESSAGE);
    expect(await readWatermark()).toBeNull();
  });

  it("uses a default lookback window for min_date_modified on a first incremental run (no watermark yet)", async () => {
    const requests = mockOrdersApi(() => []);

    // No `loadAll` -> the incremental path, and no prior etl_sync_state row
    // for this job -> the "no watermark yet" branch.
    await syncSubscriptionsEtl(env);

    expect(requests.list[0].get("min_date_modified")).toBeTruthy();
  });

  it("uses the stored watermark (minus the overlap window) as min_date_modified, and carries it in the continuation", async () => {
    const DEFAULT_LOOKBACK_HOURS_MS = 12 * 60 * 60 * 1000;
    const priorRun = Date.UTC(2026, 0, 1);
    await storeWatermark(priorRun);
    const requests = mockOrdersApi(
      () => ordersWithIds(1, ORDERS_PAGE_SIZE),
      merchandise,
    );

    const result = await syncSubscriptionsEtl(env);

    const expectedOverlapSince = priorRun - DEFAULT_LOOKBACK_HOURS_MS;
    expect(requests.list[0].get("min_date_modified")).toBe(
      new Date(expectedOverlapSince).toUTCString(),
    );
    expect(result.next?.modifiedSince).toBe(expectedOverlapSince);
  });

  it("uses the chain's own min_date_modified on follow-up messages, not one recomputed from the watermark", async () => {
    await storeWatermark(Date.UTC(2026, 5, 1));
    const modifiedSince = Date.UTC(2026, 0, 1);
    const requests = mockOrdersApi(() => []);

    await syncSubscriptionsEtl(env, {
      cursor: {
        chainStartedAt: Date.UTC(2026, 8, 1),
        modifiedSince,
        afterId: 250,
        messages: 1,
      },
    });

    expect(requests.list[0].get("min_date_modified")).toBe(
      new Date(modifiedSince).toUTCString(),
    );
  });

  it(`stops at the MAX_CHAIN_MESSAGES (${MAX_CHAIN_MESSAGES}) safety cap: logs an error, no follow-up, no watermark`, async () => {
    mockOrdersApi(() => ordersWithIds(1, ORDERS_PAGE_SIZE), merchandise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSubscriptionsEtl(env, {
      loadAll: true,
      cursor: {
        chainStartedAt: Date.UTC(2026, 8, 1),
        afterId: 0,
        messages: MAX_CHAIN_MESSAGES - 1,
      },
    });

    expect(result).toEqual({ ordersProcessed: 0 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`MAX_CHAIN_MESSAGES=${MAX_CHAIN_MESSAGES}`),
    );
    expect(await readWatermark()).toBeNull();
  });

  it("ends the chain loudly, without a watermark, if the orders list ignores min_id", async () => {
    const requests = mockOrdersApi(() => ordersWithIds(1, ORDERS_PAGE_SIZE));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSubscriptionsEtl(env, {
      loadAll: true,
      cursor: { chainStartedAt: Date.UTC(2026, 8, 1), afterId: 500, messages: 2 },
    });

    expect(result).toEqual({ ordersProcessed: 0 });
    expect(requests.productsForOrderIds).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ignored min_id=500"),
    );
    expect(await readWatermark()).toBeNull();
  });
});

describe("syncCustomersEtl / syncMinibcSubscriptionsEtl (stubs)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncCustomersEtl resolves without touching D1 or BigCommerce (not yet implemented)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(syncCustomersEtl(env)).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("not yet implemented"),
    );
  });

  it("syncMinibcSubscriptionsEtl resolves without touching D1 or BigCommerce (not yet implemented)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(syncMinibcSubscriptionsEtl(env)).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("not yet implemented"),
    );
  });
});

describe("pass-change detection and update pushes", () => {
  const APNS_TEST_KEY_ID = "ABC123DEFG";

  beforeEach(async () => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
    env.PASSKIT_TEAM_IDENTIFIER = "KJHZP635V9";
    const { exportPKCS8, generateKeyPair } = await import("jose");
    const pair = await generateKeyPair("ES256", { extractable: true });
    env.APNS_KEY_ID = APNS_TEST_KEY_ID;
    env.APNS_PRIVATE_KEY_PEM = await exportPKCS8(pair.privateKey);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.APNS_KEY_ID = undefined;
    env.APNS_PRIVATE_KEY_PEM = undefined;
    await env.DB.exec("DELETE FROM registrations");
    await env.DB.exec("DELETE FROM devices");
    await clearMembershipTables();
  });

  const fallback = {
    firstName: "Jane",
    lastName: "Doe",
  };

  function refresh() {
    return refreshMemberFromOrders(env, "jane.doe@example.com", fallback);
  }

  it("reports a new member as changed", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });

    expect(await refresh()).toEqual({ memberId: expect.stringMatching(MEMBER_ID_PATTERN), passChanged: true });
  });

  it("doesn't rewrite (or bump last_updated_at on) a member whose pass-visible fields are unchanged", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });
    await refresh();
    await env.DB.exec("UPDATE members SET last_updated_at = 123");

    expect(await refresh()).toEqual({ memberId: await memberIdFor("jane.doe@example.com"), passChanged: false });
    expect((await getMemberByEmail("jane.doe@example.com"))?.last_updated_at).toBe(123);
  });

  it.each([
    ["first name", "first_name = 'Janet'"],
    ["last name", "last_name = 'Doe-Smith'"],
    ["expiration", "expiration_date = '2000-01-01'"],
    ["member_since", "member_since = '2000-01-01'"],
  ])("reports a change when the stored %s differs from the history, and bumps last_updated_at", async (_label, staleField) => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2098-01-15" });
    await refresh();
    await env.DB.exec(`UPDATE members SET ${staleField}, last_updated_at = 123`);

    expect((await refresh())?.passChanged).toBe(true);
    expect((await getMemberByEmail("jane.doe@example.com"))?.last_updated_at).toBeGreaterThan(123);
  });

  async function registerDevice(memberId: string) {
    await env.DB.prepare("INSERT INTO devices (device_library_identifier, push_token) VALUES ('device-1', 'push-1')").run();
    await env.DB.prepare(
      "INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES ('device-1', 'pass.es.losverd.card', ?)",
    )
      .bind(memberId)
      .run();
  }

  function mockOrderAndApns(order: BigCommerceOrder) {
    const apnsCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req: RequestInfo | URL) => {
      const url = typeof req === "string" ? req : req.toString();
      if (url.startsWith("https://api.push.apple.com/")) {
        apnsCalls.push(url);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/orders/${order.id}/products`)) {
        return new Response(JSON.stringify(makeProducts()), { status: 200 });
      }
      if (url.endsWith(`/orders/${order.id}`)) {
        return new Response(JSON.stringify(order), { status: 200 });
      }
      throw new Error(`Unexpected fetch() call in test: ${url}`);
    });
    return apnsCalls;
  }

  it("syncBigCommerceOrder pushes a pass update to registered devices when the pass changed", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2097-01-15" });
    await refresh();
    await registerDevice(await memberIdFor("jane.doe@example.com"));
    const renewal = makeOrder({ date_created: "2098-06-01T00:00:00.000Z" });
    const apnsCalls = mockOrderAndApns(renewal);

    await syncBigCommerceOrder(env, "store123", renewal.id);

    expect(apnsCalls).toEqual(["https://api.push.apple.com/3/device/push-1"]);
  });

  it("syncBigCommerceOrder pushes when a refund shortens the membership", async () => {
    await insertHistoryOrder({ orderId: "1", createdOn: "2097-01-15" });
    const renewal = makeOrder({ date_created: "2098-06-01T00:00:00.000Z" });
    mockOrderAndApns(renewal);
    await syncBigCommerceOrder(env, "store123", renewal.id);
    await registerDevice(await memberIdFor("jane.doe@example.com"));
    vi.restoreAllMocks();
    const apnsCalls = mockOrderAndApns({ ...renewal, status: "Refunded" });

    await syncBigCommerceOrder(env, "store123", renewal.id);

    expect(apnsCalls).toEqual(["https://api.push.apple.com/3/device/push-1"]);
    expect((await getMemberByEmail("jane.doe@example.com"))?.expiration_date).toBe("2098-01-15");
  });

  it("syncBigCommerceOrder doesn't push when a re-synced order changes nothing", async () => {
    const order = makeOrder({ date_created: "2098-06-01T00:00:00.000Z" });
    mockOrderAndApns(order);
    await syncBigCommerceOrder(env, "store123", order.id);
    await registerDevice(await memberIdFor("jane.doe@example.com"));
    vi.restoreAllMocks();
    const apnsCalls = mockOrderAndApns(order);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(apnsCalls).toEqual([]);
  });
});


/**
 * The storefront is configured so an order never carries more than one
 * membership, and `membership_orders` is keyed on the order id, so an order
 * has one row and one membership to give. These cover the check that turns
 * that from an assumption into something we would notice breaking (#188).
 */
describe("more than one membership on an order", () => {
  async function unitsFor(orderId: number): Promise<number | null> {
    const row = await env.DB.prepare(
      "SELECT membership_units FROM membership_orders WHERE order_id = ?",
    )
      .bind(`${orderId}`)
      .first<{ membership_units: number | null }>();
    return row?.membership_units ?? null;
  }

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMembershipTables();
  });

  it("records one for an ordinary order", async () => {
    const order = makeOrder();
    mockBigCommerceOrderFetch(order, makeProducts());

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await unitsFor(order.id)).toBe(1);
  });

  it("counts a quantity above one, and still records the single membership", async () => {
    // The likelier breach of the two: adding a second line item is unusual,
    // but raising the quantity is an ordinary thing to do at checkout.
    const order = makeOrder();
    mockBigCommerceOrderFetch(order, makeProducts([{ quantity: 2 }]));

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await unitsFor(order.id)).toBe(2);
    // The member still gets the membership they would have got before. A line
    // item never withdraws anyone's membership by itself.
    expect(await getMemberByEmail("jane.doe@example.com")).not.toBeNull();
  });

  it("counts two membership line items as two", async () => {
    const order = makeOrder();
    mockBigCommerceOrderFetch(
      order,
      makeProducts([{ sku: "LOSV-MEM-0001" }, { sku: "LOSV-MEM-0001" }]),
    );

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await unitsFor(order.id)).toBe(2);
  });

  it("does not count merchandise bought alongside a membership", async () => {
    const order = makeOrder();
    mockBigCommerceOrderFetch(
      order,
      makeProducts([
        { sku: "LOSV-MEM-0001" },
        { sku: "SOME-OTHER-SKU", name: "Scarf", quantity: 3 },
      ]),
    );

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await unitsFor(order.id)).toBe(1);
  });

  it("says so once, not on every resync of the same order", async () => {
    // A resync revisits every order. Repeating the alert each time would
    // train everyone to ignore it.
    const order = makeOrder();
    mockBigCommerceOrderFetch(order, makeProducts([{ quantity: 2 }]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncBigCommerceOrder(env, "store123", order.id);
    await syncBigCommerceOrder(env, "store123", order.id);

    const carriesMany = warn.mock.calls.filter((call) =>
      String(call[0]).includes("carries 2 memberships"),
    );
    expect(carriesMany).toHaveLength(1);
  });

  it("stops flagging an order once the store is corrected", async () => {
    // Recounted from the line items every sync, so a refunded extra or a
    // corrected quantity drops the order off the report by itself.
    const order = makeOrder();
    mockBigCommerceOrderFetch(order, makeProducts([{ quantity: 2 }]));
    await syncBigCommerceOrder(env, "store123", order.id);
    expect(await unitsFor(order.id)).toBe(2);

    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockBigCommerceOrderFetch(order, makeProducts([{ quantity: 1 }]));
    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await unitsFor(order.id)).toBe(1);
  });
});

describe("countMembershipUnits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is zero when the order has no membership on it", () => {
    expect(countMembershipUnits(makeProducts([{ sku: "SOME-OTHER-SKU" }]))).toBe(0);
  });

  it("is one for a single membership", () => {
    expect(countMembershipUnits(makeProducts())).toBe(1);
  });

  it("reads a quantity BigCommerce sent as a string", () => {
    // The v2 API has a history of returning numeric fields as strings, which
    // is why `quantity` is not typed as a number.
    expect(countMembershipUnits(makeProducts([{ quantity: "2" }]))).toBe(2);
  });

  it("adds up quantities across several membership line items", () => {
    expect(
      countMembershipUnits(makeProducts([{ quantity: 2 }, { quantity: 3 }])),
    ).toBe(5);
  });

  it("counts no quantity as one, without comment", () => {
    // Not told, rather than told something that makes no sense. Our own
    // fixtures omit it, and so may any other caller.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(countMembershipUnits(makeProducts([{ quantity: undefined }]))).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([["" as const], ["abc" as const], [0], [-1], [1.5]])(
    "counts an unreadable quantity %j as one rather than as a breach",
    (quantity) => {
      // Every row on the "More than one membership" report should be a case
      // where somebody demonstrably paid for a card that does not exist. A
      // malformed response is not that, and putting ordinary orders on the
      // report would teach whoever reads it to disbelieve the list.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(countMembershipUnits(makeProducts([{ quantity }]))).toBe(1);

      // Not silent, though: it goes to the log rather than to the report.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("unreadable quantity"),
      );
    },
  );
});


describe("a store that refuses our credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([401, 403])(
    "raises a distinguishable error on %d rather than a generic failure",
    async (status) => {
      // The queue has to tell this apart from a transient failure: retrying a
      // refused token reaches the same refusal five times and then
      // dead-letters with an alert that names the queue rather than the cause.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Access denied", { status }),
      );
      const client = new BigCommerceClient("store123", "bad-token");

      await expect(client.listOrdersPage(0)).rejects.toBeInstanceOf(
        BigCommerceAuthError,
      );
    },
  );

  it("says what to go and check, and which store", async () => {
    // The store hash belongs in the message because this is the logs, not
    // Slack -- the alert built from it deliberately carries neither.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Access denied", { status: 403 }),
    );
    const client = new BigCommerceClient("store123", "bad-token");

    await expect(client.getOrderProducts(1)).rejects.toThrow(
      /refused this environment's credentials: HTTP 403 for store store123/,
    );
  });

  it("refuses before the 404-means-gone path, so a bad token is never read as a deleted order", async () => {
    // getOrderIfPresent turns a 404 into null, which flags the order as
    // missing from the store. A refused token must not take that route: it
    // would mark orders missing for a credentials problem.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Access denied", { status: 403 }),
    );
    const client = new BigCommerceClient("store123", "bad-token");

    await expect(client.getOrderIfPresent(1)).rejects.toBeInstanceOf(
      BigCommerceAuthError,
    );
  });
});

describe("the weekly full resync (#347)", () => {
  const SLACK = "https://hooks.slack.example/alert";
  const realSlack = env.SLACK_ALERT_WEBHOOK_URL;
  let email: FakeEmailBinding;
  let slackPosts: string[];
  let orderReads: number[];
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    env.BIGCOMMERCE_STORE_HASH = "store123";
    env.SLACK_ALERT_WEBHOOK_URL = SLACK;
    // Sending switched on and every order eligible by date, so that nothing
    // but the path taken stands between these runs and an email.
    env.CARD_EMAIL_NEW_ORDERS_SINCE = "2000-01-01";
    env.EMAIL_RECIPIENT_ALLOWLIST = "*";
    email = fakeEmailBinding();
    env.EMAIL = email;
    slackPosts = [];
    orderReads = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.SLACK_ALERT_WEBHOOK_URL = realSlack;
    env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
    env.EMAIL = undefined;
    await env.DB.exec("DELETE FROM card_emails");
    await env.DB.exec("DELETE FROM membership_orders");
    await env.DB.exec("DELETE FROM members");
    await env.DB.exec("DELETE FROM etl_sync_state");
  });

  /** The store: its order list, which orders it still has, and Slack. */
  function mockStore(list: BigCommerceOrder[], stillHas: Set<number> = new Set(list.map((o) => o.id))) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === SLACK) {
        slackPosts.push(JSON.parse(String(init?.body)).text);
        return new Response("ok");
      }
      if (url.includes("/orders?")) {
        const afterId = Number(new URL(url).searchParams.get("min_id"));
        const page = list.filter((order) => order.id >= afterId);
        return page.length > 0 ? new Response(JSON.stringify(page)) : new Response(null, { status: 204 });
      }
      if (/\/orders\/\d+\/products$/.test(url)) return new Response(JSON.stringify(makeProducts()));
      const single = url.match(/\/orders\/(\d+)$/);
      if (single) {
        const id = Number(single[1]);
        orderReads.push(id);
        return stillHas.has(id)
          ? new Response(JSON.stringify(makeOrder({ id })))
          : new Response(JSON.stringify([{ status: 404, message: "The requested resource was not found." }]), { status: 404 });
      }
      throw new Error(`Unexpected fetch() call in test: ${url}`);
    });
  }

  it("says nothing when a full re-read changes no card", async () => {
    mockStore([makeOrder({ id: 1 })]);
    await syncSubscriptionsEtl(env, { loadAll: true });
    slackPosts = [];

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(result.ordersProcessed).toBe(1);
    expect(slackPosts).toEqual([]);
    expect(info).toHaveBeenCalledWith("Full resync finished: 1 membership orders read, 0 cards changed");
  });

  it("counts the cards it changes across the whole chain, and says so", async () => {
    mockStore([makeOrder({ id: 121 })]);

    // The last message of a chain whose earlier ones read 120 orders and
    // changed 2 cards; this one creates a member, which is a changed card.
    await syncSubscriptionsEtl(env, {
      loadAll: true,
      cursor: { chainStartedAt: Date.now(), afterId: 120, messages: 1, ordersRead: 120, cardsChanged: 2 },
    });

    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0]).toContain("changed 3 cards (of 121 membership orders read)");
  });

  it("carries its totals to the next message", async () => {
    mockStore(Array.from({ length: 250 }, (_, i) => makeOrder({ id: i + 1 })));

    const { next } = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(next).toMatchObject({ ordersRead: MAX_MEMBERSHIP_ORDERS_PER_MESSAGE, cardsChanged: 1 });
  });

  it("hands the orders it did not see to a recheck, from when it started", async () => {
    mockStore([makeOrder({ id: 1 })]);
    const before = Date.now();

    const { recheckUnlisted } = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(recheckUnlisted).toMatchObject({ afterId: 0, reread: 0, flagged: 0 });
    expect(recheckUnlisted!.since).toBeGreaterThanOrEqual(before);
  });

  it("leaves an incremental run alone: no report, no recheck", async () => {
    mockStore([makeOrder({ id: 1 })]);

    const result = await syncSubscriptionsEtl(env);

    expect(result).toEqual({ ordersProcessed: 1 });
    expect(slackPosts).toEqual([]);
  });

  describe("recheckUnlistedOrders", () => {
    const SINCE = Date.parse("2026-09-27T04:45:00Z");

    async function holdOrder(orderId: string, updatedAt: number, fields: { source?: string; missingSince?: number } = {}) {
      await env.DB.prepare(
        `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on,
                                        first_seen_via, updated_at, missing_since)
         VALUES (?, ?, 'held@example.com', 'held@example.com', 'Completed', '2026-01-15T00:00:00Z', '2027-01-15T00:00:00Z',
                 'sync', ?, ?)`,
      )
        .bind(orderId, fields.source ?? "bigcommerce", updatedAt, fields.missingSince ?? null)
        .run();
    }

    it("re-reads only the BigCommerce orders the resync did not see, flagging those the store no longer has", async () => {
      await holdOrder("2001", SINCE - 1); // unseen, gone from the store
      await holdOrder("2002", SINCE - 1); // unseen, still in the store
      await holdOrder("2003", SINCE + 1); // seen by the resync
      await holdOrder("5f00000000000000000000e5", SINCE - 1, { source: "squarespace" });
      await holdOrder("2004", SINCE - 1, { missingSince: SINCE - 1000 }); // already flagged
      mockStore([], new Set([2002]));

      const result = await recheckUnlistedOrders(env, { since: SINCE, afterId: 0, reread: 0, flagged: 0 });

      expect(result).toEqual({});
      expect(orderReads).toEqual([2001, 2002]);
      const flagged = await env.DB.prepare("SELECT order_id FROM membership_orders WHERE missing_since IS NOT NULL ORDER BY order_id").all();
      expect(flagged.results.map((row) => row.order_id)).toEqual(["2001", "2004"]);
      expect(slackPosts.at(-1)).toContain("found 2 orders held here that the store's order list no longer returns");
      expect(slackPosts.at(-1)).toContain("1 is gone from the store");
    });

    it("never emails anyone, even for an order a new-order email would cover", async () => {
      await holdOrder("2002", SINCE - 1);
      mockStore([], new Set([2002]));

      await recheckUnlistedOrders(env, { since: SINCE, afterId: 0, reread: 0, flagged: 0 });

      expect(orderReads).toEqual([2002]);
      expect(email.sent).toEqual([]);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM card_emails").first<{ n: number }>())!.n).toBe(0);
    });

    it("works through them in batches, carrying its tallies", async () => {
      const count = MAX_UNLISTED_RECHECKS_PER_MESSAGE + 1;
      for (let id = 1; id <= count; id++) await holdOrder(String(3000 + id), SINCE - 1);
      mockStore([], new Set());

      const first = await recheckUnlistedOrders(env, { since: SINCE, afterId: 0, reread: 0, flagged: 0 });
      expect(first.next).toMatchObject({
        afterId: 3000 + MAX_UNLISTED_RECHECKS_PER_MESSAGE,
        reread: MAX_UNLISTED_RECHECKS_PER_MESSAGE,
        flagged: MAX_UNLISTED_RECHECKS_PER_MESSAGE,
      });

      const second = await recheckUnlistedOrders(env, first.next!);
      expect(second).toEqual({});
      expect(orderReads).toHaveLength(count);
      expect(slackPosts.at(-1)).toContain(`found ${count} orders`);
    });

    it("says nothing when the resync saw every order held here", async () => {
      await holdOrder("2003", SINCE + 1);
      mockStore([]);

      expect(await recheckUnlistedOrders(env, { since: SINCE, afterId: 0, reread: 0, flagged: 0 })).toEqual({});
      expect(orderReads).toEqual([]);
      expect(slackPosts).toEqual([]);
    });
  });
});
