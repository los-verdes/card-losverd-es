import { describe, expect, it } from "vitest";
import type { LegacyExport } from "../../src/legacy/import-sql";
import {
  COUNTS_SQL,
  compareCounts,
  expectedCounts,
  formatComparison,
  type ExpectedCounts,
} from "../../src/legacy/verify-import";

function exportWith(orders: Array<"squarespace" | "bigcommerce">): LegacyExport {
  return {
    format_version: 5,
    exported_at: "2026-09-20T20:00:00Z",
    member_since: [
      { email: "a@example.com", member_since: "2018-03-01" },
      { email: "b@example.com", member_since: "2019-04-02" },
    ],
    display_names: [{ email: "a@example.com", display_name: "Chuy" }],
    membership_cards: [
      {
        serial_number: "0cd5ad74-5fbc-40fd-9569-747fec277013",
        email: "a@example.com",
        full_name: "A Person",
        member_since: "2018-03-01",
        member_until: "2019-03-01",
      },
    ],
    membership_orders_total: orders.length + 3,
    membership_orders: orders.map((source, i) => ({
      order_id: source === "bigcommerce" ? `${1000 + i}_bc` : `5f0000000000000000000${i}a1`,
      source,
      order_number: null,
      channel_name: null,
      order_email: "a@example.com",
      member_email: "a@example.com",
      first_name: null,
      last_name: null,
      customer_id: null,
      sku: null,
      product_name: null,
      status: null,
      created_on: "2021-05-04T12:00:00Z",
      modified_on: null,
    })),
  };
}

const MATCHING: ExpectedCounts = {
  memberSince: 2,
  displayNames: 1,
  cards: 1,
  squarespaceOrders: 2,
  bigcommerceOrders: 1,
};

describe("what the export says should be there", () => {
  it("counts orders by era, since the two are checked differently", () => {
    const data = exportWith(["squarespace", "squarespace", "bigcommerce"]);

    expect(expectedCounts(data)).toEqual(MATCHING);
  });

  it("asks only for counts, never for anybody's data", () => {
    // This runs against production. Nothing it returns should be a name, an
    // address or an order id.
    expect(COUNTS_SQL).not.toMatch(/\b(email|first_name|last_name|order_id)\b\s*(,|$)/m);
    expect(COUNTS_SQL.match(/COUNT\(\*\)/g)).toHaveLength(5);
  });
});

describe("reading the counts back", () => {
  it("passes when everything matches", () => {
    const results = compareCounts(MATCHING, { ...MATCHING });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(formatComparison(results)).toContain("Every count matches");
  });

  it.each([
    ["memberSince", '"Member since" overrides'],
    ["displayNames", "Names members chose"],
    ["cards", "Legacy membership cards"],
    ["squarespaceOrders", "Squarespace-era orders"],
  ] as const)("fails when %s came up short", (field, label) => {
    const results = compareCounts(MATCHING, { ...MATCHING, [field]: MATCHING[field] - 1 });

    expect(results.find((r) => r.label === label)?.ok).toBe(false);
    expect(formatComparison(results)).toContain("do not decommission Postgres");
  });

  it("fails on an overshoot too, which means the import ran twice", () => {
    // Not merely noise: these tables are keyed so a re-import replaces rows
    // rather than adding them, so more than the export carried means
    // something wrote rows this import did not.
    const results = compareCounts(MATCHING, { ...MATCHING, cards: MATCHING.cards + 1 });

    expect(results.find((r) => r.label === "Legacy membership cards")?.ok).toBe(false);
  });

  it("allows more BigCommerce orders than the export carried", () => {
    // The live sync writes those as well, so a rehearsal after a resync
    // legitimately holds more. Treating that as a failure would train
    // whoever runs this to ignore the result.
    const results = compareCounts(MATCHING, { ...MATCHING, bigcommerceOrders: 500 });

    expect(results.every((r) => r.ok)).toBe(true);
    const report = formatComparison(results);
    expect(report).toContain("Every count matches");
    expect(report).toContain("normal if the BigCommerce resync has already run");
  });

  it("still fails when BigCommerce orders are short", () => {
    const results = compareCounts(MATCHING, { ...MATCHING, bigcommerceOrders: 0 });

    expect(results.find((r) => r.label === "BigCommerce-era orders")?.ok).toBe(false);
  });

  it("reports every check, not just the first failure", () => {
    const results = compareCounts(MATCHING, {
      memberSince: 0,
      displayNames: 0,
      cards: 0,
      squarespaceOrders: 0,
      bigcommerceOrders: 0,
    });

    expect(formatComparison(results)).toContain("5 of 5 checks failed");
  });
});
