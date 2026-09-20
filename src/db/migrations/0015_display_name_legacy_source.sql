-- Let the one-time legacy import record a display name (2026-09-20).
--
-- The old site let a member change the name on their own card: a
-- `POST /edit-user-name` route behind a login, calling `edit_user_name()` in
-- its `member_card/models/user.py`, which wrote `users.fullname` alongside
-- first and last name. Those choices are in the Postgres database the export
-- reads, and until now nothing carried them across -- `users.fullname` was
-- exported only into `legacy_membership_cards.full_name`, which is consulted
-- when somebody scans an old card's QR code and nowhere else.
--
-- So every member who had ever set their own name would have quietly gone
-- back to the billing name on their latest order at cutover, and the database
-- that knew better is destroyed shortly afterwards. There is no second chance
-- at this one.
--
-- Migration 0014 constrained `source` to 'member' or 'admin'. SQLite cannot
-- alter a CHECK in place, so the table is rebuilt. That is free here: it was
-- added hours ago and holds nothing yet in either environment. The rows are
-- copied rather than dropped anyway, so this stays correct if that stops
-- being true between writing and running it.
CREATE TABLE member_display_names_new (
    email TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('member', 'admin', 'legacy_postgres')),
    note TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

INSERT INTO member_display_names_new (email, display_name, source, note, updated_at)
SELECT email, display_name, source, note, updated_at FROM member_display_names;

DROP TABLE member_display_names;

ALTER TABLE member_display_names_new RENAME TO member_display_names;
