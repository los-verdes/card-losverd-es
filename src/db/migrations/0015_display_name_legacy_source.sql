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
-- Migration 0014 constrained `source` to 'member' or 'admin' and SQLite
-- cannot alter a CHECK in place, so the table is replaced rather than
-- altered. Dropped and recreated rather than copied through a temporary
-- name: `member_display_names` was created hours ago and holds nothing in
-- either environment, so there is nothing to preserve, and saying that
-- plainly is better than carrying the machinery for a case that does not
-- exist. If a name had been set on staging in the meantime, setting it again
-- is the whole of the recovery.
DROP TABLE IF EXISTS member_display_names;

CREATE TABLE member_display_names (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    display_name TEXT NOT NULL,               -- wins over the name derived from orders
    -- Who set it. Any of them may; the last to write wins, and this records
    -- which it was so a surprised member can be told where the name came from.
    -- `legacy_postgres` is the one-time import, carrying across a name the
    -- member set on the old site.
    source TEXT NOT NULL CHECK (source IN ('member', 'admin', 'legacy_postgres')),
    note TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
