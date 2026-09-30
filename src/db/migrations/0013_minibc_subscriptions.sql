-- MiniBC's membership subscriptions (#397): the store's automatic renewals.
-- Read twice a day from MiniBC's API (src/minibc/subscriptions.ts). Only what
-- says when and whether a membership renews is kept: none of a subscription's
-- names, email, addresses or payment details.
--
-- Informational only. Orders stay the record of membership: a renewal MiniBC
-- charges creates a BigCommerce order, which counts like any other, and
-- nothing here changes a card.
CREATE TABLE IF NOT EXISTS minibc_subscriptions (
    subscription_id INTEGER PRIMARY KEY,       -- MiniBC's own id
    order_id INTEGER,                          -- the BigCommerce order that started it
    origin_order_id INTEGER,                   -- MiniBC's metadata.origin_order_id, when it has one
    store_customer_id INTEGER,                 -- the BigCommerce customer paying for it
    sku TEXT NOT NULL,                         -- the membership SKU it was listed under
    status TEXT NOT NULL,                      -- MiniBC's, verbatim: active, paused, inactive (cancelled)
    signup_on TEXT,                            -- YYYY-MM-DD, or NULL where MiniBC has none
    next_payment_on TEXT,                      -- when MiniBC next charges; NULL once paused or cancelled
    paused_on TEXT,
    cancelled_on TEXT,
    minibc_modified_at INTEGER,                -- epoch ms, MiniBC's last_modified
    seen_at INTEGER NOT NULL,                  -- epoch ms: the start of the last complete read that listed it
    -- When a complete read stopped listing it. Flagged, not deleted, as with
    -- orders the store stops returning.
    missing_since INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_minibc_subscriptions_order ON minibc_subscriptions(order_id);
CREATE INDEX IF NOT EXISTS idx_minibc_subscriptions_customer ON minibc_subscriptions(store_customer_id);
