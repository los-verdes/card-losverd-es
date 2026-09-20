-- Withdrawing a membership before it expires (#31).
--
-- `revoked` has been a legal value of `members.status` since the first
-- migration and is already honoured in four places -- the access checks, the
-- status a pass carries, the Google object's state, and the admin screens.
-- Nothing could ever set it, which is what this table fixes.
--
-- It is not set on `members` because it could not survive there.
-- `deriveMembershipState()` recomputes that column from the member's orders
-- on every sync and the upsert writes it unconditionally, so a revocation
-- recorded there would be undone by the member's next order sync --
-- silently, and at a moment nobody is watching. The same reasoning that put
-- `member_since_overrides` and `member_display_names` in their own tables.
--
-- Keyed on `member_id` rather than email because that is the number printed
-- on the card being withdrawn, and it is the one identifier that never
-- changes. An email can be re-pointed by an admin; a card number cannot.
--
-- Deliberately not part of COUNTS_AS_MEMBERSHIP. Revocation is a judgement
-- about a person, and that rule scores an order. Keeping them apart is what
-- lets a revocation be lifted by deleting one row, with the membership the
-- orders describe still underneath it, unaltered.
CREATE TABLE IF NOT EXISTS revoked_cards (
    member_id TEXT PRIMARY KEY REFERENCES members(member_id),
    -- Free text, kept because a withdrawal is the kind of decision somebody
    -- will be asked to explain months later, and the Membership Committee
    -- rather than the person reading this will be the one asked.
    note TEXT,
    revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
