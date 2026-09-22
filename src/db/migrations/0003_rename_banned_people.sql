-- `banned_people` becomes `expelled_people`, in the code of conduct's own
-- word for the heaviest thing the Membership Committee can decide (#226).
-- Its two columns follow. SQLite carries the primary key and the foreign key
-- to `users` across a rename.
--
-- The view left behind under the old name is for the few seconds of every
-- deploy between this migration and the new Worker: the deploy applies
-- migrations first, and the Worker still running checks `banned_people` on
-- every signed-in request and inside every card lookup. Reads through the
-- view keep answering the same question; an expulsion or readmission
-- submitted in that window fails and can be submitted again. The next
-- migration drops the view, once no running Worker names the old table.
ALTER TABLE banned_people RENAME TO expelled_people;
ALTER TABLE expelled_people RENAME COLUMN banned_by TO expelled_by;
ALTER TABLE expelled_people RENAME COLUMN banned_at TO expelled_at;

CREATE VIEW banned_people AS
    SELECT email, note, expelled_by AS banned_by, expelled_at AS banned_at
      FROM expelled_people;
