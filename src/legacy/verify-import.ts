/**
 * Checking that an import actually landed.
 *
 * The export is the one step in the migration that cannot be repeated once
 * Postgres is gone, and until now nothing compared what it contained against
 * what reached D1. The README's spot-check printed six numbers and left
 * whoever ran it to know what they should have been -- which is exactly the
 * kind of check that gets glanced at and passed.
 *
 * The comparison lives here rather than in the CLI so it can be tested
 * without a database or a network, and so the rules about *which* mismatches
 * matter are written down in one place.
 */

import type { LegacyExport } from "./import-sql";

/** The counts an import should have produced, and how strictly. */
export interface ExpectedCounts {
  memberSince: number;
  displayNames: number;
  cards: number;
  squarespaceOrders: number;
  bigcommerceOrders: number;
}

/** The same counts, read back out of D1. */
export type ActualCounts = ExpectedCounts;

export type Comparison =
  | { kind: "exact"; label: string; expected: number; actual: number; ok: boolean }
  /**
   * A lower bound: more is fine, less is not. Used where the sync can
   * legitimately have written rows the export knows nothing about.
   */
  | { kind: "at-least"; label: string; expected: number; actual: number; ok: boolean; note: string };

export function expectedCounts(data: LegacyExport): ExpectedCounts {
  let squarespace = 0;
  let bigcommerce = 0;
  for (const order of data.membership_orders) {
    if (order.source === "squarespace") squarespace++;
    else bigcommerce++;
  }
  return {
    memberSince: data.member_since.length,
    displayNames: data.display_names.length,
    cards: data.membership_cards.length,
    squarespaceOrders: squarespace,
    bigcommerceOrders: bigcommerce,
  };
}

/**
 * What to make of the numbers.
 *
 * Four of the five are exact: nothing but this import writes a
 * `legacy_postgres`-sourced row, or a legacy card, or a Squarespace order --
 * that store has been closed since February 2023 and no other code path can
 * produce one. A count that is short means rows did not land; a count that is
 * over means the import ran twice against rows it should have replaced, which
 * is worth knowing too.
 *
 * BigCommerce orders are the exception and can only be a lower bound. The
 * live sync writes those as well, so a rehearsal that follows a resync will
 * legitimately hold more than the export carried. Short is still a failure.
 */
export function compareCounts(
  expected: ExpectedCounts,
  actual: ActualCounts,
): Comparison[] {
  const exact = (label: string, e: number, a: number): Comparison => ({
    kind: "exact",
    label,
    expected: e,
    actual: a,
    ok: e === a,
  });
  return [
    exact('"Member since" overrides', expected.memberSince, actual.memberSince),
    exact("Names members chose", expected.displayNames, actual.displayNames),
    exact("Legacy membership cards", expected.cards, actual.cards),
    exact("Squarespace-era orders", expected.squarespaceOrders, actual.squarespaceOrders),
    {
      kind: "at-least",
      label: "BigCommerce-era orders",
      expected: expected.bigcommerceOrders,
      actual: actual.bigcommerceOrders,
      ok: actual.bigcommerceOrders >= expected.bigcommerceOrders,
      note: "the live sync writes these too, so more than the export carried is expected after a resync",
    },
  ];
}

/** One line per check, then a verdict. Counts only -- never a member's data. */
export function formatComparison(results: Comparison[]): string {
  const lines = results.map((r) => {
    const mark = r.ok ? "ok  " : "FAIL";
    const relation = r.kind === "at-least" ? ">=" : "==";
    return `  ${mark} ${r.label.padEnd(26)} expected ${relation} ${r.expected}, found ${r.actual}`;
  });
  const failed = results.filter((r) => !r.ok);
  lines.push("");
  if (failed.length === 0) {
    lines.push("Every count matches the export.");
  } else {
    lines.push(
      `${failed.length} of ${results.length} checks failed. The import did not land as the export describes;`,
      "do not decommission Postgres on the strength of this run.",
    );
  }
  const shy = results.find((r) => r.kind === "at-least" && r.ok && r.actual > r.expected);
  if (shy) {
    lines.push(
      "",
      `Note: ${shy.label.toLowerCase()} exceeds the export by ${shy.actual - shy.expected}, which is`,
      "normal if the BigCommerce resync has already run against this database.",
    );
  }
  return lines.join("\n");
}

/** The single query the CLI runs against D1. Counts only, by design. */
export const COUNTS_SQL = `SELECT
    (SELECT COUNT(*) FROM member_since_overrides WHERE source = 'legacy_postgres') AS memberSince,
    (SELECT COUNT(*) FROM member_display_names WHERE source = 'legacy_postgres') AS displayNames,
    (SELECT COUNT(*) FROM legacy_membership_cards) AS cards,
    (SELECT COUNT(*) FROM membership_orders WHERE source = 'squarespace') AS squarespaceOrders,
    (SELECT COUNT(*) FROM membership_orders WHERE source = 'bigcommerce') AS bigcommerceOrders`;
