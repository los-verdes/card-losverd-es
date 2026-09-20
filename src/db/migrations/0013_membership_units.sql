-- How many memberships the order actually contained (2026-09-20).
--
-- The storefront is configured so that an order never carries more than one
-- membership, and a great deal here depends on that: `membership_orders` is
-- keyed on the order id, so an order has exactly one row and one membership
-- to give, and attribution re-points a whole order because an order is the
-- smallest thing that can be pointed at a person.
--
-- Nothing enforced that, and nothing would have noticed it being broken. A
-- second membership line item was ignored, and a line item with a quantity
-- above one was indistinguishable from a quantity of one because the
-- quantity BigCommerce sends was never read. Either way somebody had paid
-- for a membership that no card existed for, silently.
--
-- The sync now counts the memberships an order contains and records the
-- number here. Deliberately NOT part of COUNTS_AS_MEMBERSHIP: an order
-- carrying two memberships still confers the one it is recorded as, exactly
-- as before. The count raises it for a person to resolve, on the "More than
-- one membership" report -- the same choice made for orders BigCommerce
-- stops returning (migration 0011). Withdrawing a membership is a decision a
-- person makes, never a consequence of a line item.
--
-- NULL means nobody counted: every row written by the one-time legacy import,
-- whose export carries no line-item detail, and every row written before this
-- migration. NULL is not the same as 1 and is not treated as a breach.
ALTER TABLE membership_orders ADD COLUMN membership_units INTEGER;

CREATE INDEX IF NOT EXISTS idx_membership_orders_units
  ON membership_orders(membership_units);
