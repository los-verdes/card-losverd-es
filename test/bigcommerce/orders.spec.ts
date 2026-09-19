import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bigCommerceOrderKey,
  membershipExpiry,
  recordMembershipOrder,
  toIsoSeconds,
} from "../../src/bigcommerce/orders";
import {
  syncBigCommerceOrder,
  type BigCommerceOrder,
  type BigCommerceOrderProduct,
} from "../../src/bigcommerce/sync";

const ORDER: BigCommerceOrder = {
  id: 2001,
  customer_id: 77,
  status: "Completed",
  // BigCommerce's v2 API sends RFC 2822 dates.
  date_created: "Tue, 01 Sep 2026 10:00:00 +0000",
  date_modified: "Tue, 01 Sep 2026 10:30:00 +0000",
  billing_address: { first_name: "Sam", last_name: "Rivera", email: " Sam.Rivera@Example.com " },
  cart_id: "00000000-0000-4000-8000-000000000002",
  order_source: "checkout_api",
};

const PRODUCT: BigCommerceOrderProduct = {
  id: 1,
  product_id: 100,
  sku: "LOSV-MEM-0001",
  name: "Los Verdes Annual Membership",
};

async function orderRows() {
  return (await env.DB.prepare("SELECT * FROM membership_orders ORDER BY order_id").all()).results;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
});

describe("helpers", () => {
  it("formats timestamps to the second, in UTC", () => {
    expect(toIsoSeconds(new Date("2026-09-01T10:00:00.789Z"))).toBe("2026-09-01T10:00:00Z");
  });

  it("expires a membership 365 days after it started, like the legacy app", () => {
    expect(membershipExpiry(new Date("2026-09-01T10:00:00Z")).toISOString()).toBe("2027-09-01T10:00:00.000Z");
  });

  it("keys orders the way the legacy app did", () => {
    expect(bigCommerceOrderKey(1001)).toBe("1001_bc");
  });
});

describe("recordMembershipOrder", () => {
  it("leaves a transferred membership where the legacy import put it", async () => {
    // The legacy app transferred a membership with its
    // `add-memberships-to-user-email` command, which repointed
    // `annual_membership.user_id` at the recipient and left `customer_email`
    // alone. The export turns that into a `member_email` that differs from
    // `order_email`, and cards are derived from `member_email` -- so every
    // membership ever gifted or reassigned in the legacy app depends on a
    // later sync of the same order not overwriting it.
    //
    // Nothing enforces that but `member_email`'s absence from the upsert's
    // SET list, which is an easy thing to "complete" while adding a column
    // next to it. Hence this test rather than a comment.
    await recordMembershipOrder(env, ORDER, PRODUCT);
    const orderId = bigCommerceOrderKey(ORDER.id);
    await env.DB.prepare("UPDATE membership_orders SET member_email = ? WHERE order_id = ?")
      .bind("recipient@example.com", orderId)
      .run();

    await recordMembershipOrder(env, ORDER, PRODUCT);

    const [row] = await orderRows();
    expect(row.member_email).toBe("recipient@example.com");
    // The purchaser's own address still updates, since that is the store's to say.
    expect(row.order_email).toBe("sam.rivera@example.com");
  });

  it("clears the missing flag when the store returns the order again", async () => {
    // A 404 during a BigCommerce incident shouldn't leave a permanent mark;
    // the next successful sync is evidence the order is fine (#105).
    await recordMembershipOrder(env, ORDER, PRODUCT);
    await env.DB.prepare("UPDATE membership_orders SET missing_since = 1000 WHERE order_id = ?")
      .bind(bigCommerceOrderKey(ORDER.id))
      .run();

    await recordMembershipOrder(env, ORDER, PRODUCT);

    const [row] = await orderRows();
    expect(row.missing_since).toBeNull();
  });

  it("stores the order with legacy-compatible identifiers and a lowercased email", async () => {
    await recordMembershipOrder(env, ORDER, PRODUCT);

    expect(await orderRows()).toEqual([
      expect.objectContaining({
        order_id: "2001_bc",
        source: "bigcommerce",
        order_number: "2001_00000000-0000-4000-8000-000000000002",
        channel_name: "bigcommerce_checkout_api",
        order_email: "sam.rivera@example.com",
        member_email: "sam.rivera@example.com",
        first_name: "Sam",
        last_name: "Rivera",
        customer_id: 77,
        sku: "LOSV-MEM-0001",
        product_name: "Los Verdes Annual Membership",
        status: "Completed",
        test_mode: 0,
        created_on: "2026-09-01T10:00:00Z",
        expires_on: "2027-09-01T10:00:00Z",
        modified_on: "2026-09-01T10:30:00Z",
        first_seen_via: "sync",
      }),
    ]);
  });

  it("copes with an order that has no cart id, source, or modified date", async () => {
    await recordMembershipOrder(
      env,
      { ...ORDER, cart_id: null, order_source: undefined, date_modified: "" },
      PRODUCT,
    );

    expect((await orderRows())[0]).toMatchObject({
      order_number: "2001_None",
      channel_name: null,
      modified_on: null,
    });
  });

  it("refreshes the store's fields on a resync (a refund must land) without duplicating", async () => {
    await recordMembershipOrder(env, ORDER, PRODUCT);
    await recordMembershipOrder(env, { ...ORDER, status: "Refunded" }, PRODUCT);

    const rows = await orderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "Refunded", first_seen_via: "sync" });
  });

  it("converges with a legacy-imported row, keeping its member_email and provenance", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES ('2001_bc', 'bigcommerce', 'sam.rivera@example.com', 'sam.new@example.com', 'Awaiting Fulfillment', '2026-09-01T10:00:00Z', '2027-09-01T10:00:00Z', 'legacy_postgres')`,
    ).run();

    // Returns the member the order belongs to, not its billing email.
    expect(await recordMembershipOrder(env, ORDER, PRODUCT)).toBe("sam.new@example.com");

    const rows = await orderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "Completed",
      channel_name: "bigcommerce_checkout_api",
      member_email: "sam.new@example.com",
      first_seen_via: "legacy_postgres",
    });
  });

  it("answers 'who was a member on a given date' with a plain range query", async () => {
    await recordMembershipOrder(env, ORDER, PRODUCT);
    const memberOn = async (instant: string) =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM membership_orders WHERE created_on <= ?1 AND expires_on > ?1",
        )
          .bind(instant)
          .first<{ n: number }>()
      )!.n;

    expect(await memberOn("2026-08-31T00:00:00Z")).toBe(0);
    expect(await memberOn("2027-03-01T00:00:00Z")).toBe(1);
    expect(await memberOn("2027-09-02T00:00:00Z")).toBe(0);
  });
});

describe("BigCommerce sync", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
  });

  function mockOrder(products: BigCommerceOrderProduct[]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return Response.json(url.endsWith("/products") ? products : ORDER);
    });
  }

  it("records the order history row alongside the members upsert", async () => {
    mockOrder([{ ...PRODUCT, sku: "SHIRT-01", name: "Shirt" }, PRODUCT]);

    await syncBigCommerceOrder(env, "store123", ORDER.id);

    expect(await orderRows()).toEqual([
      expect.objectContaining({ order_id: "2001_bc", sku: "LOSV-MEM-0001" }),
    ]);
    const member = await env.DB.prepare("SELECT email FROM members").first();
    expect(member).toEqual({ email: "sam.rivera@example.com" });
  });

  it("records nothing for an order without a membership line item", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    mockOrder([{ ...PRODUCT, sku: "SHIRT-01", name: "Shirt" }]);

    await syncBigCommerceOrder(env, "store123", ORDER.id);

    expect(await orderRows()).toEqual([]);
  });
});
