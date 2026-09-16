-- Member-since overrides and legacy card records, per the migration plan's
-- Phase 2.2 and docs/legacy-pass-compatibility.md.
-- Additive-only, per this repo's migration house rule.

-- Authoritative "member since" dates that win over the order-derived
-- `members.member_since`. One place to reason about every date that didn't
-- come from BigCommerce orders:
--   * source = 'legacy_postgres': the one-time export of the legacy app's
--     `User.member_since` (MIN(annual_membership.created_on)) -- the only
--     surviving record of Squarespace-era join dates. Loaded by
--     scripts/legacy-export/, which never overwrites a manual row.
--   * source = 'manual': set by hand (see scripts/legacy-export/README.md)
--     to correct or backfill anyone's date.
-- Keyed by email rather than member_id, so an override can exist before
-- BigCommerce sync has created the member's row.
CREATE TABLE IF NOT EXISTS member_since_overrides (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    member_since TEXT NOT NULL,               -- ISO8601 date (YYYY-MM-DD)
    source TEXT NOT NULL CHECK (source IN ('legacy_postgres', 'manual')),
    note TEXT,                                -- free-form, e.g. why a manual date was set
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Any change to an override changes what's shown on that member's pass, so
-- bump `members.last_updated_at` -- which is what invalidates the R2 pass
-- cache and what Wallet's "passes updated since" polling compares against.
-- Triggers (not application code) so hand-run SQL gets this too. They don't
-- send an APNs push; installed passes pick the change up on their next
-- update.
CREATE TRIGGER IF NOT EXISTS member_since_overrides_after_insert
AFTER INSERT ON member_since_overrides
BEGIN
    UPDATE members SET last_updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE email = NEW.email;
END;

CREATE TRIGGER IF NOT EXISTS member_since_overrides_after_update
AFTER UPDATE ON member_since_overrides
BEGIN
    UPDATE members SET last_updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE email IN (OLD.email, NEW.email);
END;

CREATE TRIGGER IF NOT EXISTS member_since_overrides_after_delete
AFTER DELETE ON member_since_overrides
BEGIN
    UPDATE members SET last_updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE email = OLD.email;
END;

-- Legacy membership cards, so QR codes already in the world
-- (`/verify-pass/{serial_number}?signature=...`) can still be resolved to
-- a member and validity window. Closed historical data, only ever written
-- by the one-time import.
CREATE TABLE IF NOT EXISTS legacy_membership_cards (
    serial_number TEXT PRIMARY KEY,           -- legacy card UUID, lower-case hyphenated form (as in the QR URL)
    email TEXT NOT NULL,                      -- lower-cased card holder email
    full_name TEXT,
    member_since TEXT,                        -- ISO8601 date (YYYY-MM-DD)
    member_until TEXT                         -- ISO8601 date (YYYY-MM-DD)
);

CREATE INDEX IF NOT EXISTS idx_legacy_membership_cards_email ON legacy_membership_cards(email);
