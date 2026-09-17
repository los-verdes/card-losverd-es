import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeMemberships,
  expiredMemberships,
  listChannels,
  ordersByMonth,
} from "../../src/admin/reportQueries";
import { insertOrder } from "./fixtures";

const AS_OF = "2026-06-01T12:00:00Z";

beforeEach(async () => {
  // Current, and renewed early: two orders in force at AS_OF, one member.
  await insertOrder({ id: "1_bc", email: "renewer@example.com", first: "Rene", last: "Wer", created: "2025-07-01T00:00:00Z" });
  await insertOrder({ id: "2_bc", email: "renewer@example.com", first: "Rene", last: "Wer", created: "2026-05-20T00:00:00Z", channel: "bigcommerce_iphone" });
  // Current, Squarespace-era style row with no status or channel.
  await insertOrder({ id: "5f00000000000000000000b2", source: "squarespace", email: "steady@example.com", created: "2025-09-09T00:00:00Z", status: null, channel: null });
  // Lapsed: last order expired 2025-03-01, an older one before it.
  await insertOrder({ id: "3_bc", email: "lapsed@example.com", first: "Lap", last: "Sed", created: "2023-03-01T00:00:00Z" });
  await insertOrder({ id: "4_bc", email: "lapsed@example.com", first: "Lap", last: "Sed", created: "2024-03-01T00:00:00Z" });
  // Old order under an old address, renewed under the new one: NOT lapsed.
  await insertOrder({ id: "5_bc", email: "old.address@example.com", memberEmail: "moved@example.com", created: "2024-01-01T00:00:00Z" });
  await insertOrder({ id: "6_bc", email: "moved@example.com", created: "2026-01-01T00:00:00Z" });
  // Never memberships: refunded, cancelled (Squarespace spelling), a test order.
  await insertOrder({ id: "7_bc", email: "refunded@example.com", created: "2026-02-01T00:00:00Z", status: "Refunded" });
  await insertOrder({ id: "sq-void", source: "squarespace", email: "void@example.com", created: "2026-02-02T00:00:00Z", status: "CANCELED" });
  await insertOrder({ id: "sq-test", source: "squarespace", email: "tester@example.com", created: "2026-02-03T00:00:00Z", testMode: true });
  // Not yet placed at AS_OF.
  await insertOrder({ id: "8_bc", email: "future@example.com", created: "2026-08-01T00:00:00Z" });
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM membership_orders");
});

describe("activeMemberships", () => {
  it("lists orders in force at the instant, newest first, skipping voided and test orders", async () => {
    const result = await activeMemberships(env.DB, AS_OF);

    expect(result.rows.map((r) => r.order_id)).toEqual(["2_bc", "6_bc", "5f00000000000000000000b2", "1_bc"]);
    expect(result.totalOrders).toBe(4);
    expect(result.totalMembers).toBe(3); // the early renewer counts once
  });

  it("answers for a past date: who was a member then", async () => {
    const result = await activeMemberships(env.DB, "2024-06-01T00:00:00Z");

    expect(result.rows.map((r) => r.order_id)).toEqual(["4_bc", "5_bc"]);
  });

  it("treats the expiry instant itself as no longer in force", async () => {
    const atExpiry = await activeMemberships(env.DB, "2025-03-01T00:00:00Z", { search: "lapsed" });
    const justBefore = await activeMemberships(env.DB, "2025-02-28T23:59:59Z", { search: "lapsed" });

    expect(atExpiry.rows).toEqual([]);
    expect(justBefore.rows.map((r) => r.order_id)).toEqual(["4_bc"]);
  });

  it("filters by search across both emails and the billing name, case-insensitively", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { search: "RENEWER@" })).totalOrders).toBe(2);
    expect((await activeMemberships(env.DB, AS_OF, { search: "rene wer" })).totalOrders).toBe(2);
    expect((await activeMemberships(env.DB, "2024-06-01T00:00:00Z", { search: "moved@" })).rows.map((r) => r.order_id)).toEqual(["5_bc"]);
    expect((await activeMemberships(env.DB, AS_OF, { search: "   " })).totalOrders).toBe(4);
  });

  it("treats LIKE wildcards in a search literally", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { search: "%" })).totalOrders).toBe(0);
    expect((await activeMemberships(env.DB, AS_OF, { search: "renewer_example" })).totalOrders).toBe(0);
  });

  it("filters by channel, alone and combined with search", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { channel: "bigcommerce_iphone" })).rows.map((r) => r.order_id)).toEqual(["2_bc"]);
    expect((await activeMemberships(env.DB, AS_OF, { channel: "bigcommerce_iphone", search: "steady" })).totalOrders).toBe(0);
  });

  it("pages the rows but not the totals", async () => {
    const result = await activeMemberships(env.DB, AS_OF, {}, { limit: 2, offset: 2 });

    expect(result.rows.map((r) => r.order_id)).toEqual(["5f00000000000000000000b2", "1_bc"]);
    expect(result.totalOrders).toBe(4);
  });
});

describe("expiredMemberships", () => {
  it("lists each lapsed member once, by their most recent order", async () => {
    const result = await expiredMemberships(env.DB, AS_OF);

    expect(result.rows.map((r) => r.order_id)).toEqual(["4_bc"]);
    expect(result.rows[0]).toMatchObject({ member_email: "lapsed@example.com", expires_on: "2025-03-01T00:00:00Z" });
    expect(result.total).toBe(1);
  });

  it("doesn't list someone who renewed under a different address", async () => {
    const emails = (await expiredMemberships(env.DB, AS_OF)).rows.map((r) => r.member_email);

    expect(emails).not.toContain("moved@example.com");
  });

  it("ignores orders placed after the instant: a since-renewed member was lapsed back then", async () => {
    const result = await expiredMemberships(env.DB, "2025-06-01T00:00:00Z");

    expect(result.rows.map((r) => r.member_email).sort()).toEqual(["lapsed@example.com", "moved@example.com"]);
  });

  it("filters and pages", async () => {
    const asOf = "2025-06-01T00:00:00Z";

    expect((await expiredMemberships(env.DB, asOf, { search: "lap sed" })).total).toBe(1);
    expect((await expiredMemberships(env.DB, asOf, { channel: "bigcommerce_iphone" })).total).toBe(0);
    const paged = await expiredMemberships(env.DB, asOf, {}, { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});

describe("ordersByMonth", () => {
  it("counts real membership orders per month for the year and the year before, with empty months as zero", async () => {
    const months = await ordersByMonth(env.DB, 2026);

    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ month: "01", orders: 1, previous_year_orders: 0 });
    expect(months[1]).toEqual({ month: "02", orders: 0, previous_year_orders: 0 }); // all three February orders are void
    expect(months[4]).toEqual({ month: "05", orders: 1, previous_year_orders: 0 });
    expect(months[6]).toEqual({ month: "07", orders: 0, previous_year_orders: 1 });
    expect(months[7]).toEqual({ month: "08", orders: 1, previous_year_orders: 0 });
    expect(months[8]).toEqual({ month: "09", orders: 0, previous_year_orders: 1 });
  });
});

describe("listChannels", () => {
  it("lists distinct non-null channels alphabetically", async () => {
    expect(await listChannels(env.DB)).toEqual(["bigcommerce_iphone", "bigcommerce_www"]);
  });
});
