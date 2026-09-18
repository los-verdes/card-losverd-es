/**
 * Which `membership_orders` rows (migration 0008) count as a membership.
 * Shared by the member sync (src/bigcommerce/sync.ts), which derives each
 * member's card from these rows, and the admin reports
 * (src/admin/reportQueries.ts), so a card and a report never disagree about
 * the same order.
 *
 * Statuses are stored verbatim from each store, and the two stores don't mean
 * the same things by them, so the rule is per source.
 */

/**
 * BigCommerce statuses that mean the membership was paid for (decided
 * 2026-09-17). Everything else is excluded, including `Incomplete`,
 * `Pending` and `Awaiting Payment` -- an unpaid order gets no card -- along
 * with `Refunded`, `Cancelled`, `Declined`, `Disputed` and the rest.
 */
export const PAID_BIGCOMMERCE_STATUSES = [
  "awaiting fulfillment",
  "awaiting shipment",
  "completed",
  "shipped",
];

/**
 * Squarespace-era orders are closed history with their own vocabulary
 * (`FULFILLED`, `PENDING`, `CANCELED`), where `PENDING` means paid but not
 * yet shipped -- not BigCommerce's "payment pending". Many legacy rows have
 * no status at all. So these keep the legacy app's rule
 * (`AnnualMembership.is_canceled`): everything counts except a cancelled
 * order. Applying BigCommerce's allow-list here would silently drop real
 * historical members.
 */
export const VOID_LEGACY_STATUSES = ["canceled", "cancelled", "refunded", "declined"];

const list = (values: string[]) => values.map((value) => `'${value}'`).join(", ");

/**
 * SQL condition on a `membership_orders` row: does this order count?
 *
 * **Three-valued, and the third value matters.** For a `bigcommerce` row with
 * a NULL status this evaluates to NULL, not 0, because `lower(NULL) IN (...)`
 * is NULL. Legacy imports produce exactly such rows in quantity
 * (los-verdes/card-losverd-es#89), so this is not a hypothetical.
 *
 * As written -- a `WHERE` clause, or a selected column read for truthiness --
 * that is correct and needs no thought: NULL is not true, so the order does
 * not count. Two ways of using it are not safe, and both fail silently on
 * precisely those rows:
 *
 * - `NOT (COUNTS_AS_MEMBERSHIP)` to find non-counting rows. `NOT NULL` is
 *   NULL, so statusless orders match neither the condition nor its negation.
 *   Use `COALESCE((COUNTS_AS_MEMBERSHIP), 0) = 0`.
 * - Comparing a selected `counts` column with `=== 0` in TypeScript. D1
 *   hands NULL back as `null`. Compare truthily.
 */
export const COUNTS_AS_MEMBERSHIP = `test_mode = 0 AND (CASE source
    WHEN 'bigcommerce' THEN lower(status) IN (${list(PAID_BIGCOMMERCE_STATUSES)})
    ELSE (status IS NULL OR lower(status) NOT IN (${list(VOID_LEGACY_STATUSES)}))
  END)`;
