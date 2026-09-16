import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BigCommerceClient,
  syncBigCommerceOrder,
  syncCustomersEtl,
  syncMinibcSubscriptionsEtl,
  syncSubscriptionsEtl,
  upsertMemberFromOrder,
  type BigCommerceOrder,
  type BigCommerceOrderProduct,
} from "../../src/bigcommerce/sync";

interface MemberRow {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  membership_tier: string;
  status: string;
  expiration_date: string;
  auth_token: string;
  last_updated_at: number;
}

async function getMemberByEmail(email: string): Promise<MemberRow | null> {
  return env.DB.prepare("SELECT * FROM members WHERE email = ?")
    .bind(email)
    .first<MemberRow>();
}

async function countMembers(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM members",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

function makeOrder(
  overrides: Partial<BigCommerceOrder> = {},
): BigCommerceOrder {
  return {
    id: 1001,
    customer_id: 42,
    status: "Complete",
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

describe("upsertMemberFromOrder", () => {
  afterEach(async () => {
    await env.DB.exec("DELETE FROM members");
  });

  it("inserts a new member on first sync", async () => {
    await upsertMemberFromOrder(env, {
      customerId: 42,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.doe@example.com",
      membershipTier: "standard",
      expirationDate: "2027-01-15",
      status: "active",
    });

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member).not.toBeNull();
    expect(member?.member_id).toBe("BC-42");
    expect(member?.first_name).toBe("Jane");
    expect(member?.membership_tier).toBe("standard");
    expect(member?.status).toBe("active");
    expect(member?.expiration_date).toBe("2027-01-15");
    expect(member?.auth_token).toBeTruthy();
  });

  it("is idempotent: running the same upsert twice produces one row, unchanged auth_token", async () => {
    const input = {
      customerId: 42,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.doe@example.com",
      membershipTier: "standard",
      expirationDate: "2027-01-15",
      status: "active" as const,
    };

    await upsertMemberFromOrder(env, input);
    const firstPass = await getMemberByEmail("jane.doe@example.com");

    await upsertMemberFromOrder(env, input);
    const secondPass = await getMemberByEmail("jane.doe@example.com");

    expect(await countMembers()).toBe(1);
    expect(secondPass?.member_id).toBe(firstPass?.member_id);
    expect(secondPass?.auth_token).toBe(firstPass?.auth_token);
  });

  it("updates existing fields (e.g. renewed expiration) without duplicating the row", async () => {
    await upsertMemberFromOrder(env, {
      customerId: 42,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.doe@example.com",
      membershipTier: "standard",
      expirationDate: "2027-01-15",
      status: "active",
    });

    await upsertMemberFromOrder(env, {
      customerId: 42,
      firstName: "Jane",
      lastName: "Doe-Smith",
      email: "jane.doe@example.com",
      membershipTier: "standard",
      expirationDate: "2028-01-15",
      status: "active",
    });

    expect(await countMembers()).toBe(1);
    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.last_name).toBe("Doe-Smith");
    expect(member?.expiration_date).toBe("2028-01-15");
  });

  it("preserves an existing member_id and auth_token when matched by email", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, auth_token, last_updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "LV-10023",
        "Jane",
        "Doe",
        "jane.doe@example.com",
        "standard",
        "active",
        "2026-06-01",
        "pre-migrated-token",
        now,
      )
      .run();

    await upsertMemberFromOrder(env, {
      customerId: 999, // a different BigCommerce customer_id than any pre-existing linkage would imply
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.doe@example.com",
      membershipTier: "standard",
      expirationDate: "2027-06-01",
      status: "active",
    });

    expect(await countMembers()).toBe(1);
    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.member_id).toBe("LV-10023");
    expect(member?.auth_token).toBe("pre-migrated-token");
    expect(member?.expiration_date).toBe("2027-06-01");
  });

  it("lower-cases email on insert so lookups are case-insensitive", async () => {
    await upsertMemberFromOrder(env, {
      customerId: 7,
      firstName: "Al",
      lastName: "Smith",
      email: "Al.Smith@EXAMPLE.com",
      membershipTier: "standard",
      expirationDate: "2027-01-01",
      status: "active",
    });

    const member = await getMemberByEmail("al.smith@example.com");
    expect(member).not.toBeNull();
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
    await expect(client.getOrder(1)).rejects.toThrow(/500/);
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

  it("listOrdersPage returns [] on a 204 (past the last page)", async () => {
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

  it("listOrdersPage defaults to no extra filter params when none are given", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === "string" ? input : input.toString();
        return new Response(null, { status: 204 });
      },
    );

    await client.listOrdersPage(3);

    const params = new URL(requestedUrl).searchParams;
    expect(params.get("page")).toBe("3");
    expect(params.get("min_date_modified")).toBeNull();
  });
});

describe("syncBigCommerceOrder", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.exec("DELETE FROM members");
  });

  it("fetches the order + products and upserts a members row", async () => {
    const order = makeOrder();
    const products = makeProducts();
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member).not.toBeNull();
    expect(member?.member_id).toBe("BC-42");
    expect(member?.membership_tier).toBe("standard");
    // order.date_created (2026-01-15) + 365 days
    expect(member?.expiration_date).toBe("2027-01-15");
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

  it("computes status=expired for an order whose one-year membership period has already lapsed", async () => {
    const order = makeOrder({ id: 3003, date_created: "2020-01-01T00:00:00.000Z" });
    const products = makeProducts();
    mockBigCommerceOrderFetch(order, products);

    await syncBigCommerceOrder(env, "store123", order.id);

    const member = await getMemberByEmail("jane.doe@example.com");
    expect(member?.status).toBe("expired");
    // 2020 is a leap year, so +365 days from Jan 1 lands on Dec 31, not Jan 1.
    expect(member?.expiration_date).toBe("2020-12-31");
  });
});

describe("syncSubscriptionsEtl", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    env.BIGCOMMERCE_STORE_HASH = "store123";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.exec("DELETE FROM members");
    await env.DB.exec("DELETE FROM etl_sync_state");
  });

  it("pages through orders, upserts membership orders, and records a watermark", async () => {
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

    let pageRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          pageRequests++;
          if (pageRequests === 1) {
            return new Response(JSON.stringify([orderA, orderB]), {
              status: 200,
            });
          }
          return new Response(null, { status: 204 });
        }
        if (
          url.endsWith(`/orders/${orderA.id}/products`) ||
          url.endsWith(`/orders/${orderB.id}/products`)
        ) {
          return new Response(JSON.stringify(makeProducts()), { status: 200 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(result.ordersProcessed).toBe(2);
    expect(await countMembers()).toBe(2);
    expect(await getMemberByEmail("jane.doe@example.com")).not.toBeNull();
    expect(await getMemberByEmail("bo.jones@example.com")).not.toBeNull();

    const watermark = await env.DB.prepare(
      "SELECT last_run_at FROM etl_sync_state WHERE job_name = 'sync_subscriptions_etl'",
    ).first<{ last_run_at: number }>();
    expect(watermark?.last_run_at).toBeGreaterThan(0);
  });

  it("running the full resync twice is idempotent (no duplicate members)", async () => {
    const order = makeOrder();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          // Page 1 always returns the one order; every later page (in either
          // run) is empty, so each run terminates after processing it once.
          const page = new URL(url).searchParams.get("page");
          if (page === "1") {
            return new Response(JSON.stringify([order]), { status: 200 });
          }
          return new Response(null, { status: 204 });
        }
        if (url.endsWith(`/orders/${order.id}/products`)) {
          return new Response(JSON.stringify(makeProducts()), { status: 200 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    await syncSubscriptionsEtl(env, { loadAll: true });
    await syncSubscriptionsEtl(env, { loadAll: true });

    expect(await countMembers()).toBe(1);
  });

  it("stops at the MAX_PAGES safety cap instead of paging forever", async () => {
    // Mirrors sync.ts's private MAX_PAGES=50: mock every page as non-empty
    // (never returning the 204 that would otherwise end the loop) so the
    // cap itself - not "ran out of orders" - is what stops the sync.
    const MAX_PAGES = 50;
    let pageRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          pageRequests++;
          return new Response(JSON.stringify([makeOrder({ id: pageRequests })]), {
            status: 200,
          });
        }
        if (url.includes("/products")) {
          // Non-membership SKU: resolveMembershipTier() returns null, so no
          // D1 write happens per page - keeps this test fast across 50 pages.
          return new Response(
            JSON.stringify(makeProducts([{ sku: "NON-MEMBERSHIP-SKU", name: "T-Shirt" }])),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(pageRequests).toBe(MAX_PAGES);
    expect(result.ordersProcessed).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`MAX_PAGES=${MAX_PAGES}`),
    );
  });

  it("uses a default lookback window for min_date_modified on a first incremental run (no watermark yet)", async () => {
    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          requestedUrl = url;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    // No `loadAll` -> the incremental path, and no prior etl_sync_state row
    // for this job -> getWatermark()'s "no watermark yet" branch.
    await syncSubscriptionsEtl(env);

    expect(new URL(requestedUrl).searchParams.get("min_date_modified")).toBeTruthy();
  });

  it("uses the stored watermark (minus the overlap window) as min_date_modified on a later incremental run", async () => {
    const DEFAULT_LOOKBACK_HOURS_MS = 12 * 60 * 60 * 1000;
    const priorRun = Date.UTC(2026, 0, 1);
    await env.DB.prepare(
      "INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)",
    )
      .bind("sync_subscriptions_etl", priorRun, priorRun)
      .run();

    let requestedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/orders?")) {
          requestedUrl = url;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch() call in test: ${url}`);
      },
    );

    await syncSubscriptionsEtl(env);

    const expectedOverlapSince = priorRun - DEFAULT_LOOKBACK_HOURS_MS;
    expect(new URL(requestedUrl).searchParams.get("min_date_modified")).toBe(
      new Date(expectedOverlapSince).toUTCString(),
    );
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
