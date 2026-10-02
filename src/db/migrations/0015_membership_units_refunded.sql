-- How many of an order's memberships BigCommerce reports as refunded, summed
-- over its membership line items' `quantity_refunded`. NULL until the order
-- is next read from the store (the weekly full resync reads every one), and
-- whenever the store didn't say.
--
-- What lets a `Partially Refunded` order keep counting as a membership while
-- what was refunded was something else on it (COUNTS_AS_MEMBERSHIP in
-- src/lib/membershipOrders.ts). NULL counts as "don't know", which doesn't.
ALTER TABLE membership_orders ADD COLUMN membership_units_refunded INTEGER;
