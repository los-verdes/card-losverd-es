-- The name a member wants on their card (2026-09-20).
--
-- Until now the name on a card was the billing name from the member's most
-- recent counted order, re-derived from order history on every sync, with no
-- way to set it. That left three situations with no answer: a gifted
-- membership kept showing the giver's name until the recipient bought
-- something themselves, a changed name could not be corrected without
-- placing an order, and a name somebody actually goes by never appeared at
-- all, because a payment card was the only thing with a say (#189).
--
-- Its own table, for the same reason `member_since_overrides` is its own
-- table (migration 0005): `deriveMembershipState()` recomputes
-- `members.first_name` and `members.last_name` from the latest order and the
-- upsert writes them unconditionally, so a name stored there would be
-- reverted at the member's next order sync -- silently, and at a moment
-- nobody is watching. Keeping the override outside `members` also leaves the
-- derived name intact underneath, which makes "put it back to the name on my
-- orders" a delete rather than a guess.
--
-- One free-text field rather than a first/last pair. A membership card is a
-- fun vanity item rather than an identity document and gets very little
-- scrutiny, so it is fine for a card not to show somebody's real name
-- (decided 2026-09-20). One field handles a mononym, a nickname and a name
-- that does not split into two parts, none of which a first/last pair does
-- well.
CREATE TABLE IF NOT EXISTS member_display_names (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    display_name TEXT NOT NULL,               -- wins over the name derived from orders
    -- Who set it. Both may; the last one to write wins, and this records
    -- which it was so a surprised member can be told where the name came from.
    source TEXT NOT NULL CHECK (source IN ('member', 'admin')),
    note TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
