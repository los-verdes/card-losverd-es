import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTS_AS_MEMBERSHIP } from "../../src/lib/membershipOrders";

/**
 * Pins the three-valued behaviour of the shared counting rule against real
 * SQLite, rather than against anyone's recollection of how `IN` treats NULL.
 *
 * The rule is documented as returning NULL (not 0) for a BigCommerce row with
 * no status, and callers are told to compare truthily and to negate through
 * COALESCE. Legacy imports produce such rows in quantity (#89), and a caller
 * who gets this wrong is wrong *only* on those rows -- so the failure is both
 * silent and concentrated exactly where it does harm. These tests exist so
 * that documentation cannot quietly drift away from the SQL.
 */

async function insert(orderId: string, source: string, status: string | null) {
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name,
       status, test_mode, created_on, expires_on, first_seen_via)
     VALUES (?, ?, 'someone@example.com', 'someone@example.com', 'Test', 'Member', ?, 0, '2025-01-01', '2026-01-01', 'sync')`,
  )
    .bind(orderId, source, status)
    .run();
}

/** The rule's raw value for one order: 1, 0, or null. */
async function countsValue(orderId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT (${COUNTS_AS_MEMBERSHIP}) AS counts FROM membership_orders WHERE order_id = ?`,
  )
    .bind(orderId)
    .first<{ counts: number | null }>();
  return row?.counts ?? null;
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM membership_orders");
});

describe("COUNTS_AS_MEMBERSHIP", () => {
  it("is 1 for a paid BigCommerce order and 0 for an unpaid one", async () => {
    await insert("1001_bc", "bigcommerce", "Completed");
    await insert("1002_bc", "bigcommerce", "Awaiting Payment");
    expect(await countsValue("1001_bc")).toBe(1);
    expect(await countsValue("1002_bc")).toBe(0);
  });

  it("is NULL, not 0, for a BigCommerce order with no status", async () => {
    // `lower(NULL) IN (...)` is NULL. This is the shape every statusless
    // legacy import lands in.
    await insert("1003_bc", "bigcommerce", null);
    expect(await countsValue("1003_bc")).toBeNull();
  });

  it("still counts a statusless legacy order, where NULL is handled explicitly", async () => {
    await insert("abc123def456abc123def456", "squarespace", null);
    expect(await countsValue("abc123def456abc123def456")).toBe(1);
  });

  it("excludes the statusless order from a WHERE clause, which is the intended answer", async () => {
    await insert("1001_bc", "bigcommerce", "Completed");
    await insert("1003_bc", "bigcommerce", null);
    const { results } = await env.DB.prepare(
      `SELECT order_id FROM membership_orders WHERE ${COUNTS_AS_MEMBERSHIP}`,
    ).all<{ order_id: string }>();
    expect(results.map((row) => row.order_id)).toEqual(["1001_bc"]);
  });

  it("does not find the statusless order through NOT, which is the trap", async () => {
    // Both the condition and its negation exclude it, so a caller looking for
    // non-counting rows with NOT silently misses the ones that matter most.
    await insert("1002_bc", "bigcommerce", "Awaiting Payment");
    await insert("1003_bc", "bigcommerce", null);
    const { results } = await env.DB.prepare(
      `SELECT order_id FROM membership_orders WHERE NOT (${COUNTS_AS_MEMBERSHIP})`,
    ).all<{ order_id: string }>();
    expect(results.map((row) => row.order_id)).toEqual(["1002_bc"]);
  });

  it("finds it through COALESCE, which is what callers should use", async () => {
    await insert("1002_bc", "bigcommerce", "Awaiting Payment");
    await insert("1003_bc", "bigcommerce", null);
    const { results } = await env.DB.prepare(
      `SELECT order_id FROM membership_orders WHERE COALESCE((${COUNTS_AS_MEMBERSHIP}), 0) = 0
       ORDER BY order_id`,
    ).all<{ order_id: string }>();
    expect(results.map((row) => row.order_id)).toEqual(["1002_bc", "1003_bc"]);
  });

  it("never counts a test-mode order, whatever its status", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name, last_name,
         status, test_mode, created_on, expires_on, first_seen_via)
       VALUES ('1004_bc', 'bigcommerce', 'someone@example.com', 'someone@example.com', 'Test', 'Member',
         'Completed', 1, '2025-01-01', '2026-01-01', 'sync')`,
    ).run();
    expect(await countsValue("1004_bc")).toBe(0);
  });
});
