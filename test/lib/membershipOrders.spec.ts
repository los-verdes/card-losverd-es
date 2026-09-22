import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTS_AS_MEMBERSHIP } from "../../src/lib/membershipOrders";

/**
 * Pins the shared counting rule against real SQLite rather than against
 * anyone's recollection of how `IN` treats NULL.
 *
 * The rule promises to be two-valued, which takes a deliberate `COALESCE` to
 * achieve: a `bigcommerce` row with no status would otherwise evaluate to
 * NULL, and legacy imports produce those rows in quantity (#89). The promise
 * is what everything else relies on -- a caller negating the rule, or
 * comparing a selected column with 0, is right only because of it -- so it is
 * asserted here directly.
 */

async function insert(orderId: string, source: string, status: string | null) {
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name,
       status, created_on, expires_on, first_seen_via)
     VALUES (?, ?, 'someone@example.com', 'someone@example.com', 'Test', 'Member', ?, '2025-01-01', '2026-01-01', 'sync')`,
  )
    .bind(orderId, source, status)
    .run();
}

async function setFrozen(orderId: string, verdict: number | null) {
  await env.DB.prepare("UPDATE membership_orders SET frozen_counts = ? WHERE order_id = ?")
    .bind(verdict, orderId)
    .run();
}

/** The rule's raw value for one order. */
async function countsValue(orderId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT (${COUNTS_AS_MEMBERSHIP}) AS counts FROM membership_orders WHERE order_id = ?`,
  )
    .bind(orderId)
    .first<{ counts: number | null }>();
  return row?.counts ?? null;
}

async function orderIdsWhere(condition: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT order_id FROM membership_orders WHERE ${condition} ORDER BY order_id`,
  ).all<{ order_id: string }>();
  return results.map((row) => row.order_id);
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM membership_orders");
});

describe("COUNTS_AS_MEMBERSHIP", () => {
  it("is 1 for a paid BigCommerce order and 0 for an unpaid one", async () => {
    await insert("1001", "bigcommerce", "Completed");
    await insert("1002", "bigcommerce", "Awaiting Payment");
    expect(await countsValue("1001")).toBe(1);
    expect(await countsValue("1002")).toBe(0);
  });

  it("is 0, not NULL, for a BigCommerce order with no status", async () => {
    // The case the COALESCE exists for. `lower(NULL) IN (...)` is NULL, and
    // this is the shape every statusless legacy import lands in (#89).
    await insert("1003", "bigcommerce", null);
    expect(await countsValue("1003")).toBe(0);
  });

  it("takes a stored verdict over the status, either way", async () => {
    // Squarespace's PENDING meant paid; its verdict was fixed at import and
    // must not be re-read through BigCommerce's vocabulary.
    await insert("5f00000000000000000000e1", "squarespace", "PENDING");
    await insert("5f00000000000000000000e2", "squarespace", "Completed");
    await setFrozen("5f00000000000000000000e1", 1);
    await setFrozen("5f00000000000000000000e2", 0);
    expect(await countsValue("5f00000000000000000000e1")).toBe(1);
    expect(await countsValue("5f00000000000000000000e2")).toBe(0);
  });

  it("selects only counting orders in a WHERE clause", async () => {
    await insert("1001", "bigcommerce", "Completed");
    await insert("1003", "bigcommerce", null);
    expect(await orderIdsWhere(COUNTS_AS_MEMBERSHIP)).toEqual(["1001"]);
  });

  it("finds every non-counting order when negated, statusless ones included", async () => {
    // Being two-valued is what makes this work. While the rule could return
    // NULL, `NOT (...)` stayed NULL and silently skipped exactly the orders
    // most likely to need finding.
    await insert("1001", "bigcommerce", "Completed");
    await insert("1002", "bigcommerce", "Awaiting Payment");
    await insert("1003", "bigcommerce", null);
    expect(await orderIdsWhere(`NOT (${COUNTS_AS_MEMBERSHIP})`)).toEqual([
      "1002",
      "1003",
    ]);
  });

  it("answers the same question asked as `= 0`", async () => {
    // The other shape a caller reaches for, and the one that would have been
    // wrong for precisely the statusless orders and right everywhere else.
    await insert("1002", "bigcommerce", "Awaiting Payment");
    await insert("1003", "bigcommerce", null);
    expect(await orderIdsWhere(`(${COUNTS_AS_MEMBERSHIP}) = 0`)).toEqual([
      "1002",
      "1003",
    ]);
  });

  it("sums to the number of counting orders, with no NULLs to skip", async () => {
    await insert("1001", "bigcommerce", "Completed");
    await insert("1003", "bigcommerce", null);
    const row = await env.DB.prepare(
      `SELECT SUM(${COUNTS_AS_MEMBERSHIP}) AS counted, COUNT(*) AS total FROM membership_orders`,
    ).first<{ counted: number; total: number }>();
    expect(row).toEqual({ counted: 1, total: 2 });
  });
});

describe("migration 0004, freezing the Squarespace-era verdicts", () => {
  const MIGRATION = Object.values(
    import.meta.glob("../../src/db/migrations/0004_*.sql", { query: "?raw", import: "default", eager: true }),
  )[0] as string;
  const backfill = MIGRATION.slice(MIGRATION.indexOf("UPDATE membership_orders")).trim();

  it.each([
    ["FULFILLED", 1],
    ["PENDING", 1], // paid, not yet shipped
    [null, 1],
    ["CANCELED", 0],
    ["cancelled", 0],
    ["Refunded", 0],
    ["DECLINED", 0],
  ])("gives a Squarespace %s order the verdict %i", async (status, verdict) => {
    await insert("5f00000000000000000000f1", "squarespace", status);

    await env.DB.prepare(backfill).run();

    expect(await countsValue("5f00000000000000000000f1")).toBe(verdict);
  });

  it("leaves BigCommerce orders to the paid-status rule", async () => {
    await insert("1004", "bigcommerce", "Pending");

    await env.DB.prepare(backfill).run();

    const row = await env.DB.prepare("SELECT frozen_counts FROM membership_orders WHERE order_id = '1004'").first();
    expect(row).toEqual({ frozen_counts: null });
    expect(await countsValue("1004")).toBe(0);
  });
});
