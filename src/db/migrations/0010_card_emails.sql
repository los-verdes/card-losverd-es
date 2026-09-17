-- One row per membership order we have emailed a card for, written *before*
-- the send (los-verdes/card-losverd-es#70). Cloudflare Queues and BigCommerce
-- webhooks both deliver at least once, so without this a retry or a duplicate
-- delivery would email the same member again; the insert claims the send, and
-- a second attempt finds the row and stops.
--
-- Only the new-order path (src/email/newOrder.ts) writes here. A member
-- asking for their own card at /email-card, or an admin attributing an order,
-- are separate, deliberate sends and are not recorded.
-- Additive-only, per this repo's migration house rule.
CREATE TABLE IF NOT EXISTS card_emails (
    order_id TEXT PRIMARY KEY REFERENCES membership_orders(order_id),
    member_email TEXT NOT NULL,                -- lowercased; who it was sent to
    sent_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
