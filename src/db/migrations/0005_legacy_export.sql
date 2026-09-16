-- One-time exports from the legacy app's Postgres database, per the
-- migration plan's Phase 2.2 and docs/legacy-pass-compatibility.md.
-- Populated by scripts/legacy-export/ (see its README); closed historical
-- data, so these tables are only ever written by that import.
-- Additive-only, per this repo's migration house rule.

-- Earliest membership order per legacy user (the legacy app's
-- `User.member_since`: MIN(annual_membership.created_on)). The only
-- remaining source for Squarespace-era join dates -- the Squarespace
-- account itself is gone.
CREATE TABLE IF NOT EXISTS legacy_member_since (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    member_since TEXT NOT NULL                -- ISO8601 date (YYYY-MM-DD)
);

-- Legacy membership cards, so QR codes already in the world
-- (`/verify-pass/{serial_number}?signature=...`) can still be resolved to
-- a member and validity window.
CREATE TABLE IF NOT EXISTS legacy_membership_cards (
    serial_number TEXT PRIMARY KEY,           -- legacy card UUID, lower-case hyphenated form (as in the QR URL)
    email TEXT NOT NULL,                      -- lower-cased card holder email
    full_name TEXT,
    member_since TEXT,                        -- ISO8601 date (YYYY-MM-DD)
    member_until TEXT                         -- ISO8601 date (YYYY-MM-DD)
);

CREATE INDEX IF NOT EXISTS idx_legacy_membership_cards_email ON legacy_membership_cards(email);
