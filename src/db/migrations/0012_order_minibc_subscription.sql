-- The MiniBC subscription behind each BigCommerce membership order (#397).
-- MiniBC writes a `minibc` metafield, `subscription_id`, onto every order it
-- creates, the first and each renewal, a few minutes after the order itself.
--
-- `minibc_checked_at` is when the store was last asked. An order is not asked
-- again once it has a subscription, or once it was asked about a day or more
-- after it was placed and had none: by then MiniBC would have written it.
ALTER TABLE membership_orders ADD COLUMN minibc_subscription_id INTEGER;
ALTER TABLE membership_orders ADD COLUMN minibc_checked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_membership_orders_minibc_subscription
  ON membership_orders(minibc_subscription_id) WHERE minibc_subscription_id IS NOT NULL;
