/**
 * Which `membership_orders` rows (migration 0008) count as a membership.
 * Shared by the member sync (src/bigcommerce/sync.ts), which derives each
 * member's card from these rows, and the admin reports
 * (src/admin/reportQueries.ts), so a card and a report never disagree about
 * the same order.
 */

/**
 * Orders that never counted as a membership: Squarespace test orders, and
 * orders the store voided. Statuses are stored verbatim from each store, so
 * this covers Squarespace's `CANCELED` (the only status the legacy app
 * excluded) plus BigCommerce's equivalents.
 */
export const VOID_STATUSES = ["canceled", "cancelled", "refunded", "declined"];

/** SQL condition on a `membership_orders` row: does this order count? */
export const COUNTS_AS_MEMBERSHIP = `test_mode = 0 AND (status IS NULL OR lower(status) NOT IN (${VOID_STATUSES.map((s) => `'${s}'`).join(", ")}))`;
