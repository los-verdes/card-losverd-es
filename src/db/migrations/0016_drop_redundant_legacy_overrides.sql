-- Removes the overrides carried over from the previous site that no longer
-- do anything, or that were only ever needed for orders this site cannot
-- re-read.
--
-- The one-time import (source 'legacy_postgres') brought across a "member
-- since" date and, where it differed from the latest order, a card name for
-- each person the previous site knew. They were there to cover the
-- Squarespace years, whose orders no store will describe again. Compared with
-- the orders on 2026-09-29, and again on 2026-10-02 once a partially refunded
-- order counted while its membership wasn't refunded:
--
-- * Every imported "member since" either equals what the person's orders
--   give, or belongs to somebody with no Squarespace-era order at all, whose
--   history is entirely BigCommerce and so complete here. In the second case
--   the previous site's date could only have come from something the orders
--   no longer say -- a test or cancelled order, or drift where it missed a
--   later update -- so the orders are the better answer. All are removed.
-- * An imported card name is removed only where it equals the name the
--   orders give, ignoring case and outer spaces (or where the address has no
--   card and no counted order for a name to come from), so it changes
--   nothing. A name that differs may be one the member chose on the previous
--   site, and stays.
--
-- Overrides a member or an admin set are never touched here. Each removal
-- that changes what a card says is recorded against its person; the rest,
-- changing nothing, are recorded as one summary line per table, so the audit
-- log's recent activity is not buried under thousands of no-ops. Removing a
-- "member since" row marks that member's card stale through the table's own
-- triggers, so passes pick up any change on their next update.
--
-- "Counts as a membership" below is COUNTS_AS_MEMBERSHIP in
-- src/lib/membershipOrders.ts, spelled out because a migration cannot import
-- it; test/db/dropRedundantLegacyOverrides.spec.ts holds the two together.

INSERT INTO audit_log (action, subject_email, actor_email, detail)
SELECT 'member_since.cleared', o.email, NULL,
       'Removed the previous site''s "member since" of ' || o.member_since || '; their orders give ' ||
       COALESCE(m.member_since, 'none') || ', and none of them is from the Squarespace years'
  FROM member_since_overrides o
  JOIN members m ON m.email = o.email
 WHERE o.source = 'legacy_postgres'
   AND o.member_since IS NOT m.member_since
   AND NOT EXISTS (SELECT 1 FROM membership_orders x WHERE x.member_email = o.email AND x.source = 'squarespace');

INSERT INTO audit_log (action, subject_email, actor_email, detail)
SELECT 'member_since.cleared', NULL, NULL,
       'Removed ' || n || ' "member since" date(s) carried over from the previous site: each matched what the person''s orders give, or belonged to somebody with no Squarespace-era order, whose history this site holds in full'
  FROM (SELECT COUNT(*) AS n
          FROM member_since_overrides o
         WHERE o.source = 'legacy_postgres'
           AND (o.member_since IS COALESCE(
                  (SELECT m.member_since FROM members m WHERE m.email = o.email),
                  (SELECT substr(MIN(x.created_on), 1, 10) FROM membership_orders x
                    WHERE x.member_email = o.email
                      AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0)))
                OR NOT EXISTS (SELECT 1 FROM membership_orders x WHERE x.member_email = o.email AND x.source = 'squarespace')))
 WHERE n > 0;

DELETE FROM member_since_overrides
 WHERE source = 'legacy_postgres'
   AND (member_since IS COALESCE(
          (SELECT m.member_since FROM members m WHERE m.email = member_since_overrides.email),
          (SELECT substr(MIN(x.created_on), 1, 10) FROM membership_orders x
            WHERE x.member_email = member_since_overrides.email
              AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0)))
        OR NOT EXISTS (SELECT 1 FROM membership_orders x WHERE x.member_email = member_since_overrides.email AND x.source = 'squarespace'));

INSERT INTO audit_log (action, subject_email, actor_email, detail)
SELECT 'display_name.cleared', NULL, NULL,
       'Removed ' || n || ' card name(s) carried over from the previous site that matched the name the person''s orders give, so changed nothing'
  FROM (SELECT COUNT(*) AS n
          FROM member_display_names d
         WHERE d.source = 'legacy_postgres'
           AND (lower(trim(d.display_name)) = COALESCE(
                  (SELECT lower(trim(m.first_name || ' ' || m.last_name)) FROM members m WHERE m.email = d.email),
                  (SELECT lower(trim(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, ''))) FROM membership_orders x
                    WHERE x.member_email = d.email
                      AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0)
                    ORDER BY x.created_on DESC LIMIT 1))
                OR (NOT EXISTS (SELECT 1 FROM members m WHERE m.email = d.email)
                    AND NOT EXISTS (SELECT 1 FROM membership_orders x
                                     WHERE x.member_email = d.email
                                       AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0)))))
 WHERE n > 0;

DELETE FROM member_display_names
 WHERE source = 'legacy_postgres'
   AND (lower(trim(display_name)) = COALESCE(
          (SELECT lower(trim(m.first_name || ' ' || m.last_name)) FROM members m WHERE m.email = member_display_names.email),
          (SELECT lower(trim(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, ''))) FROM membership_orders x
            WHERE x.member_email = member_display_names.email
              AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0)
            ORDER BY x.created_on DESC LIMIT 1))
        OR (NOT EXISTS (SELECT 1 FROM members m WHERE m.email = member_display_names.email)
            AND NOT EXISTS (SELECT 1 FROM membership_orders x
                             WHERE x.member_email = member_display_names.email
                               AND COALESCE(x.frozen_counts, (lower(x.status) IN ('awaiting fulfillment', 'awaiting shipment', 'completed', 'partially shipped', 'shipped') OR (lower(x.status) = 'partially refunded' AND x.membership_units > x.membership_units_refunded)), 0))));
