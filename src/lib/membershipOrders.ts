/**
 * Which `membership_orders` rows count as a membership.
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
  // Paid, and some of it already sent. Found on four real orders in the old
  // system's data (#89), which this list would have dropped -- an order
  // half-shipped is no less paid for than one shipped whole, and nobody
  // would have been able to explain to those four why their card stopped.
  "partially shipped",
  "shipped",
];

/**
 * Squarespace-era orders are closed history with their own vocabulary
 * (`FULFILLED`, `PENDING`, `CANCELED`), where `PENDING` means paid but not
 * yet shipped -- not BigCommerce's "payment pending". So these keep the
 * legacy app's rule (`AnnualMembership.is_canceled`): everything counts
 * except a cancelled order. Applying BigCommerce's allow-list here would
 * silently drop real historical members.
 *
 * This comment used to say that many legacy rows carry no status at all.
 * Measured against the old system's database in September 2026, none do --
 * across both eras and every order channel (#89). The rule is unchanged,
 * since it mirrors what that system did rather than resting on how many
 * rows had a gap.
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
/**
 * SQL condition on a `membership_orders` row: is the person it is attributed
 * to still a member in good standing?
 *
 * Separate from `COUNTS_AS_MEMBERSHIP` because the two answer different
 * questions. That rule scores an order -- was it paid, was it refunded --
 * and a revocation says nothing about the order. Somebody whose membership
 * is revoked still bought what they bought, and the money is still the
 * group's, so the sale stays on the books.
 *
 * Which is exactly why this has to be applied by hand where it belongs. Only
 * reports about *who is a member now* want it: somebody whose membership is revoked must not be
 * listed as current, or the reports and the access checks would tell
 * different stories about the same person and whoever answered their next
 * question would be reading the wrong one. Reports about what was sold --
 * orders by month, consolidations, the order-level flags -- must not have it,
 * or the group's own sales history would quietly change when somebody was
 * asked to leave.
 *
 * Correlated on `member_email`, so it goes in a `WHERE` on an unaliased
 * `membership_orders`.
 */
export const MEMBER_IN_GOOD_STANDING = `NOT EXISTS (
    SELECT 1 FROM members mm
      JOIN revoked_cards rc ON rc.member_id = mm.member_id
     WHERE mm.email = membership_orders.member_email
  ) AND NOT EXISTS (
    SELECT 1 FROM banned_people bp
     WHERE bp.email = membership_orders.member_email
  )`;

export const COUNTS_AS_MEMBERSHIP = `COALESCE((CASE source
    WHEN 'bigcommerce' THEN lower(status) IN (${list(PAID_BIGCOMMERCE_STATUSES)})
    ELSE (status IS NULL OR lower(status) NOT IN (${list(VOID_LEGACY_STATUSES)}))
  END), 0)`;
