-- BigCommerce order ids without the `_bc` suffix.
--
-- The previous site appended `_bc` to every BigCommerce order id, against a
-- worry that one might collide with a Squarespace id while both stores were in
-- use. They cannot: a Squarespace id is 24 hexadecimal characters and a
-- BigCommerce one a short integer, and `membership_orders.source` records
-- which store an order came from regardless. The suffix only ever meant that
-- the id in the admin screens and reports was not the id the Merch Team sees
-- in the store.
--
-- New orders are keyed on the bare id (`bigCommerceOrderKey()`), and the legacy
-- export strips it. This brings any row already written into line, so that a
-- later sync of the same order updates it rather than inserting a second row
-- beside it.
--
-- Two tables reference `membership_orders.order_id`, and changing a parent key
-- would violate their foreign keys between one statement and the next.
-- Deferring the check to the end of the transaction is D1's documented way
-- through that: all three are rewritten, and the constraint is checked once,
-- against the finished result.
--
-- Only BigCommerce rows ending in exactly `_bc` are touched. A Squarespace id
-- never has an underscore, and anything else is left as it is rather than
-- guessed at.
PRAGMA defer_foreign_keys = on;

UPDATE membership_orders
   SET order_id = substr(order_id, 1, length(order_id) - 3)
 WHERE source = 'bigcommerce' AND order_id LIKE '%\_bc' ESCAPE '\';

UPDATE membership_order_attributions
   SET order_id = substr(order_id, 1, length(order_id) - 3)
 WHERE order_id LIKE '%\_bc' ESCAPE '\';

UPDATE card_emails
   SET order_id = substr(order_id, 1, length(order_id) - 3)
 WHERE order_id LIKE '%\_bc' ESCAPE '\';

PRAGMA defer_foreign_keys = off;
