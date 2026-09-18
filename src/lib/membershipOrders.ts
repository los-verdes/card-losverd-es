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
 * Always 0 or 1, never NULL -- which takes a deliberate `COALESCE` to
 * guarantee. Left to itself the expression is three-valued: for a
 * `bigcommerce` row with a NULL status, `lower(NULL) IN (...)` is NULL rather
 * than false, and legacy imports produce exactly those rows in quantity
 * (los-verdes/card-losverd-es#89).
 *
 * NULL would be harmless in the two ways this is used today -- as a `WHERE`
 * clause, where NULL is not true and the order correctly does not count, and
 * as a selected column read for truthiness. It is a trap in the two obvious
 * ways it might be used next: `NOT (...)` stays NULL rather than becoming
 * true, so it silently fails to find precisely the statusless orders, and a
 * selected column compared with `=== 0` in TypeScript misses them the same
 * way. Both of those now behave as anyone would expect.
 *
 * The honest answer for a statusless BigCommerce order is that it does not
 * count, so 0 is what the rule should say. NULL was only ever an artefact of
 * how `IN` treats NULL.
 */
export const COUNTS_AS_MEMBERSHIP = `COALESCE(test_mode = 0 AND (CASE source
    WHEN 'bigcommerce' THEN lower(status) IN (${list(PAID_BIGCOMMERCE_STATUSES)})
    ELSE (status IS NULL OR lower(status) NOT IN (${list(VOID_LEGACY_STATUSES)}))
  END), 0)`;
