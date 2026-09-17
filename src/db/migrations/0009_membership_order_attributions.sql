-- Audit trail for admins attributing a membership order to someone other
-- than its purchaser (los-verdes/card-losverd-es#70): a gift, or a member
-- whose current email differs from the one on an old order. The attribution
-- itself is `membership_orders.member_email`; this table records who changed
-- it, when, from what, and why. Rows are only ever appended.
--
-- Its existence for an order also tells the one-time legacy import not to
-- overwrite that order's member_email (src/legacy/import-sql.ts).
-- Additive-only, per this repo's migration house rule.
CREATE TABLE IF NOT EXISTS membership_order_attributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES membership_orders(order_id),
    previous_member_email TEXT NOT NULL,       -- lowercased
    member_email TEXT NOT NULL,                -- lowercased; the new attribution
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_membership_order_attributions_order ON membership_order_attributions(order_id);
