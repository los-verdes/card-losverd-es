-- Restores letters the previous site lost from names, wherever a clean copy
-- of the same name is on record for the same person.
--
-- Some names came across in the one-time import from the previous site with
-- a letter replaced by U+FFFD, the replacement character ("�"): the old
-- system had lost it before the export, most likely an accented letter read
-- in the wrong encoding when Squarespace's data first reached it. Nothing
-- this site has read from BigCommerce or Slack itself is affected. Counted
-- on 2026-09-29: 31 order rows, all loaded by the import, and 8 imported card
-- names, 7 of them on a current card. None has more than one lost letter in
-- an order's first or last name, or more than two in a card name.
--
-- The lost letter cannot be worked out from the garbled copy, only found
-- elsewhere. So a garbled name is repaired only from another of the same
-- person's orders whose name is clean and matches it letter for letter, each
-- "�" standing for exactly one letter (LIKE, so ASCII case aside). Only the
-- lost letter is taken from that copy: everything else, capitals included,
-- stays as the garbled name had it, so a name somebody chose in capitals
-- keeps them. Where no such copy exists nothing is guessed, and the name is
-- left for a person who knows it.
--
-- A card name repaired this way is recorded against its person in the audit
-- log, and their card marked stale so passes pick it up. Order rows are
-- store data restored, which the log does not record, as it does not record
-- an order syncing.
--
-- LIKE treats `%` and `_` as wildcards, so both are escaped (with `\`) before
-- each "�" becomes `_`, which matches exactly one character. Positions line
-- up character for character, which is what lets the letter be copied across
-- by position.

-- 1. Order rows. At most one lost letter per name part, so one pass.
UPDATE membership_orders
   SET first_name = CASE WHEN instr(first_name, char(65533)) > 0 THEN
         substr(first_name, 1, instr(first_name, char(65533)) - 1) ||
         substr((SELECT c.first_name FROM membership_orders c
                  WHERE c.member_email = membership_orders.member_email
                    AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
                    AND COALESCE(c.first_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.first_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                    AND COALESCE(c.last_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.last_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                  ORDER BY c.created_on DESC, c.order_id LIMIT 1), instr(first_name, char(65533)), 1) ||
         substr(first_name, instr(first_name, char(65533)) + 1)
       ELSE first_name END,
       last_name = CASE WHEN instr(last_name, char(65533)) > 0 THEN
         substr(last_name, 1, instr(last_name, char(65533)) - 1) ||
         substr((SELECT c.last_name FROM membership_orders c
                  WHERE c.member_email = membership_orders.member_email
                    AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
                    AND COALESCE(c.first_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.first_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                    AND COALESCE(c.last_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.last_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                  ORDER BY c.created_on DESC, c.order_id LIMIT 1), instr(last_name, char(65533)), 1) ||
         substr(last_name, instr(last_name, char(65533)) + 1)
       ELSE last_name END
 WHERE instr(COALESCE(first_name, '') || COALESCE(last_name, ''), char(65533)) > 0
   AND EXISTS (
         SELECT 1 FROM membership_orders c
          WHERE c.member_email = membership_orders.member_email
            AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
            AND COALESCE(c.first_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.first_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
            AND COALESCE(c.last_name, '') LIKE replace(replace(replace(replace(COALESCE(membership_orders.last_name, ''), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\');

-- 2. Card names: recorded and their cards marked stale first, while the
-- lost letters still say which ones they are.
INSERT INTO audit_log (action, subject_email, actor_email, detail)
SELECT 'display_name.repaired', d.email, NULL,
       'Restored the letters the previous site had lost from the card name "' || d.display_name || '", from their orders'
  FROM member_display_names d
 WHERE instr(d.display_name, char(65533)) > 0
   AND EXISTS (
         SELECT 1 FROM membership_orders c
          WHERE c.member_email = d.email
            AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
            AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                LIKE replace(replace(replace(replace(trim(d.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\');

UPDATE members
   SET last_updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE email IN (
         SELECT d.email FROM member_display_names d
          WHERE instr(d.display_name, char(65533)) > 0
            AND EXISTS (
                  SELECT 1 FROM membership_orders c
                   WHERE c.member_email = d.email
                     AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
                     AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                         LIKE replace(replace(replace(replace(trim(d.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'));

-- 3. Card names, one lost letter per pass; two passes, as none has more.
UPDATE member_display_names
   SET display_name =
         substr(trim(display_name), 1, instr(trim(display_name), char(65533)) - 1) ||
         substr((SELECT trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) FROM membership_orders c
                  WHERE c.member_email = member_display_names.email
                    AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
                    AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                        LIKE replace(replace(replace(replace(trim(member_display_names.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                  ORDER BY c.created_on DESC, c.order_id LIMIT 1), instr(trim(display_name), char(65533)), 1) ||
         substr(trim(display_name), instr(trim(display_name), char(65533)) + 1)
 WHERE instr(display_name, char(65533)) > 0
   AND EXISTS (
         SELECT 1 FROM membership_orders c
          WHERE c.member_email = member_display_names.email
            AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
            AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                LIKE replace(replace(replace(replace(trim(member_display_names.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\');

UPDATE member_display_names
   SET display_name =
         substr(trim(display_name), 1, instr(trim(display_name), char(65533)) - 1) ||
         substr((SELECT trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) FROM membership_orders c
                  WHERE c.member_email = member_display_names.email
                    AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
                    AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                        LIKE replace(replace(replace(replace(trim(member_display_names.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\'
                  ORDER BY c.created_on DESC, c.order_id LIMIT 1), instr(trim(display_name), char(65533)), 1) ||
         substr(trim(display_name), instr(trim(display_name), char(65533)) + 1)
 WHERE instr(display_name, char(65533)) > 0
   AND EXISTS (
         SELECT 1 FROM membership_orders c
          WHERE c.member_email = member_display_names.email
            AND instr(COALESCE(c.first_name, '') || COALESCE(c.last_name, ''), char(65533)) = 0
            AND trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))
                LIKE replace(replace(replace(replace(trim(member_display_names.display_name), '\', '\\'), '%', '\%'), '_', '\_'), char(65533), '_') ESCAPE '\');
