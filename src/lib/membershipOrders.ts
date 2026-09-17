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
 * BigCommerce statuses that mean the membership was paid for (Jeff,
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

/** SQL condition on a `membership_orders` row: does this order count? */
export const COUNTS_AS_MEMBERSHIP = `test_mode = 0 AND (CASE source
    WHEN 'bigcommerce' THEN lower(status) IN (${list(PAID_BIGCOMMERCE_STATUSES)})
    ELSE (status IS NULL OR lower(status) NOT IN (${list(VOID_LEGACY_STATUSES)}))
  END)`;
