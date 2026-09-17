-- Comprehensive membership order history: one row per membership order, ever.
-- `members` holds only each member's *current* state; this table is what
-- answers historical questions ("who was a member on a given date", orders
-- per day vs. the previous year, lapsed members) for admin reporting
-- (los-verdes/card-losverd-es#53). Ports the legacy `annual_membership`
-- table. Additive-only, per this repo's migration house rule.
--
-- Two writers, converging on the same rows:
--   * BigCommerce sync (src/bigcommerce/orders.ts), on every webhook/resync.
--   * The one-time legacy Postgres import (scripts/legacy-export/), which is
--     the only surviving record of Squarespace-era orders.
-- `order_id` keeps the legacy key format -- `{id}_bc` for BigCommerce, the raw
-- Squarespace id otherwise -- precisely so both writers hit the same row.
--
-- Timestamps are ISO8601 UTC text (`YYYY-MM-DDTHH:MM:SSZ`), which sorts
-- chronologically and works with SQLite's date functions.
CREATE TABLE IF NOT EXISTS membership_orders (
    order_id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('bigcommerce', 'squarespace')),
    order_number TEXT,                         -- legacy display number (`{id}_{cart_id}` for BigCommerce)
    channel_name TEXT,                         -- e.g. bigcommerce_www, bigcommerce_iphone
    order_email TEXT NOT NULL,                 -- lowercased; the address given on the order itself
    member_email TEXT NOT NULL,                -- lowercased; who we currently consider the member (may differ from order_email)
    first_name TEXT,
    last_name TEXT,
    customer_id INTEGER,                       -- BigCommerce customer id; NULL for Squarespace
    sku TEXT,
    product_name TEXT,
    status TEXT,                               -- the store's own order status, verbatim (e.g. Completed, Refunded, CANCELED)
    test_mode INTEGER NOT NULL DEFAULT 0,      -- Squarespace's test-order flag; always 0 for BigCommerce
    created_on TEXT NOT NULL,                  -- start of the membership period
    expires_on TEXT NOT NULL,                  -- created_on + 365 days, stored so date-window queries can use an index
    modified_on TEXT,
    first_seen_via TEXT NOT NULL CHECK (first_seen_via IN ('sync', 'legacy_postgres')),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_membership_orders_order_email ON membership_orders(order_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_member_email ON membership_orders(member_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_window ON membership_orders(created_on, expires_on);
