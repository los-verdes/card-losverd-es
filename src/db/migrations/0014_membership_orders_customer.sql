-- Membership orders by the BigCommerce customer who placed them: how a MiniBC
-- subscription is matched to its member when none of its orders is held here
-- (src/minibc/renewals.ts, #397).
CREATE INDEX IF NOT EXISTS idx_membership_orders_customer
  ON membership_orders(customer_id) WHERE customer_id IS NOT NULL;
