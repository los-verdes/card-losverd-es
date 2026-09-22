-- The `banned_people` view migration 0003 left behind is no longer needed
-- (#226). It covered the seconds of one deploy while the previous Worker,
-- which still named the old table, was running; that deploy has completed in
-- both environments, and nothing running reads the old name any more.
--
-- Numbered 0005 rather than 0004 because 0004 was already taken by an open
-- pull request when this was written. The two are independent, so the order
-- they apply in does not matter.
DROP VIEW IF EXISTS banned_people;
