-- People barred from the group (#31).
--
-- Rarely, the Membership Committee bars somebody from Los Verdes. In practice
-- that is usually for a couple of years, but it is recorded here as
-- indefinite and lifted by hand: a date that expires on its own would put the
-- person back in without anybody deciding they should be, which is not a
-- decision software should make.
--
-- Two things follow from a ban, and they are different from a withdrawn card.
-- A withdrawn membership stops the card working; the person can still sign in
-- and still exists here. A ban also stops them signing in at all, and takes
-- effect on sessions they already hold.
--
-- Keyed on the email address, because that is what this system knows a person
-- by -- the same key `members`, `member_since_overrides` and the login
-- identities all use. It follows the person rather than a particular card, so
-- it covers memberships they buy later under the same address. It cannot
-- cover a different address, which is a real limit and is written down in the
-- provenance document rather than pretended away.
CREATE TABLE IF NOT EXISTS banned_people (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    -- Free text. A ban is the most consequential thing this software does to
    -- a person, and whoever is asked about it later will not be whoever made
    -- the decision.
    note TEXT,
    banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    banned_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
