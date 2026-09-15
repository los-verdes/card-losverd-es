import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  syncBigCommerceOrder,
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
});
