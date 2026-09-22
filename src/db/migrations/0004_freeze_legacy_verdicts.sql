-- Each Squarespace-era order's counted-or-not verdict, worked out once and
-- kept with the order (#215).
--
-- Those orders were scored by a rule of their own -- they count unless
-- cancelled, refunded or declined, because Squarespace's `PENDING` meant
-- paid -- where BigCommerce orders must carry a paid status. No store will
-- ever update them again, so re-deriving their verdict from code on every
-- query bought nothing except a second rule to maintain, and a way for a
-- closed year's figures to change years later because somebody tidied a
-- status list.
--
-- The UPDATE below is that rule, applied for the last time; `frozen_counts`
-- is what `COUNTS_AS_MEMBERSHIP` (src/lib/membershipOrders.ts) reads from
-- now on. NULL for every order a store still describes, which the paid-status
-- rule scores. Adding a column is safe with the previous Worker still
-- running: it names the columns it reads, and this is not one of them.
ALTER TABLE membership_orders ADD COLUMN frozen_counts INTEGER CHECK (frozen_counts IN (0, 1));

UPDATE membership_orders
   SET frozen_counts = (status IS NULL OR lower(status) NOT IN ('canceled', 'cancelled', 'refunded', 'declined'))
 WHERE source = 'squarespace';
