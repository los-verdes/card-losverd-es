-- The email MiniBC gives for a subscription's customer (#470), lowercased.
--
-- 0013 kept none of a subscription's contact details. This one is kept for a
-- single purpose: a hint at the likely member for a subscription no order
-- matches, most often one started from a guest checkout, which has no store
-- customer to follow. It is never used to match: orders alone decide which
-- member a subscription belongs to (src/minibc/renewals.ts), and nothing here
-- changes a card.
ALTER TABLE minibc_subscriptions ADD COLUMN customer_email TEXT;
