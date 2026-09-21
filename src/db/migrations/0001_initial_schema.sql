-- The schema, whole. This file replaces the first twenty migrations, and a
-- later one that only rewrote `_bc`-suffixed order ids in existing rows -- data
-- a rebuilt database never holds, since the legacy export strips the suffix.
--
-- Several of those existed only to correct earlier ones -- a column added and
-- dropped again, a table replaced hours after it was created -- and none of
-- that is useful to anybody working out what a table is for today. What it
-- cost was real: every fresh database in every test run applied all twenty.
--
-- **A squash rewrites what "already applied" means.** A database that ran the
-- old files will not run this one, so this is only safe while every database
-- can be thrown away and rebuilt. What keeps that true is the Squarespace-era
-- order history existing somewhere other than production -- Postgres until it
-- is decommissioned, and the export JSON for as long as that file is kept.
-- When the last of those goes, production holds the only copy and no squash
-- can be undone by recreating the database. See "Squash the migrations" in
-- docs/cutover.md.
--
-- This also retires `src/db/schema.sql`, which mirrored the migrations by hand
-- for anyone wanting to read the schema in one piece. That is now this file,
-- and a copy that has to be kept in step is a copy that eventually is not.

-- Members / Pass Holders Table
CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY,               -- e.g. LV-10023 or UUID
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',    -- active, expired, revoked
    expiration_date TEXT,                     -- ISO8601 string (YYYY-MM-DD)
    member_since TEXT,                        -- ISO8601 string (YYYY-MM-DD)
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- linked login identity, if any
    auth_token TEXT NOT NULL,                 -- Secret token generated for Apple PassKit auth
    last_updated_at INTEGER NOT NULL,         -- Unix epoch (ms) for cache validation
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_updated ON members(last_updated_at);

-- Registered Devices (iPhone, Apple Watch, etc.)
CREATE TABLE IF NOT EXISTS devices (
    device_library_identifier TEXT PRIMARY KEY,
    push_token TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Registrations Mapping (Relationship between Pass and Device)
CREATE TABLE IF NOT EXISTS registrations (
    device_library_identifier TEXT NOT NULL,
    pass_type_identifier TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    PRIMARY KEY (device_library_identifier, serial_number),
    FOREIGN KEY (device_library_identifier) REFERENCES devices(device_library_identifier) ON DELETE CASCADE,
    FOREIGN KEY (serial_number) REFERENCES members(member_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_registrations_lookup
ON registrations (device_library_identifier, pass_type_identifier);

-- Diagnostic Logging from Apple Devices
CREATE TABLE IF NOT EXISTS pass_device_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_level TEXT DEFAULT 'error',
    message TEXT NOT NULL,
    logged_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- ETL Sync State (watermarks for scheduled BigCommerce/MiniBC resync jobs --
-- see docs/bigcommerce-ingestion.md)
CREATE TABLE IF NOT EXISTS etl_sync_state (
    job_name TEXT PRIMARY KEY,                -- e.g. 'sync_subscriptions_etl'
    last_run_at INTEGER NOT NULL,             -- Unix epoch (ms) of the last successful run start
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- The name a member wants shown on their card.
-- Wins over the name derived from orders; absent means use the derived one.
-- `legacy_postgres` is the one-time import carrying across a name the member
-- set on the old site, which had its own name-change page.
CREATE TABLE IF NOT EXISTS member_display_names (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('member', 'admin', 'legacy_postgres')),
    note TEXT,
    set_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- who set the name
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Memberships revoked before they expire.
-- Keyed on the card number, which never changes. Its own table because
-- `members.status` is recomputed from orders on every sync.
CREATE TABLE IF NOT EXISTS revoked_cards (
    member_id TEXT PRIMARY KEY REFERENCES members(member_id),
    note TEXT,
    revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- People expelled from the group. Indefinite by design; lifted by hand.
-- Stops them signing in, and revokes any membership they hold.
CREATE TABLE IF NOT EXISTS banned_people (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    note TEXT,
    banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    banned_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Append-only record of decisions people make about memberships. Written
-- alongside the tables above, never instead of them: they answer "what is
-- true now", this answers "what happened".
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,                     -- e.g. membership.revoked, card.emailed
    subject_email TEXT,                       -- lower-cased; the person it was about
    actor_email TEXT,                         -- lower-cased; null when nobody was signed in
    detail TEXT NOT NULL,                     -- one line, composed at the time
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON audit_log(subject_email, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_recent ON audit_log(id DESC);

-- Login Identities
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    first_name TEXT,
    last_name TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,      -- collapses the legacy roles/roles_users tables; "admin" is the only role in use
    bigcommerce_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Linked OAuth Provider Identities
CREATE TABLE IF NOT EXISTS oauth_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                   -- 'google' | 'apple' | 'yahoo'
    provider_user_id TEXT NOT NULL,           -- provider's stable subject/user id
    email_at_link_time TEXT,                  -- diagnostic only; current email lives on users.email
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

-- Member-since overrides + legacy cards. The triggers below bump
-- members.last_updated_at whenever an override changes.
CREATE TABLE IF NOT EXISTS member_since_overrides (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    member_since TEXT NOT NULL,               -- ISO8601 date (YYYY-MM-DD); wins over members.member_since
    source TEXT NOT NULL CHECK (source IN ('legacy_postgres', 'manual')),
    note TEXT,
    set_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- who made the correction
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

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

CREATE TABLE IF NOT EXISTS legacy_membership_cards (
    serial_number TEXT PRIMARY KEY,           -- legacy card UUID, lower-case hyphenated form (as in the QR URL)
    email TEXT NOT NULL,                      -- lower-cased card holder email
    full_name TEXT,
    member_since TEXT,                        -- ISO8601 date (YYYY-MM-DD)
    member_until TEXT                         -- ISO8601 date (YYYY-MM-DD)
);

CREATE INDEX IF NOT EXISTS idx_legacy_membership_cards_email ON legacy_membership_cards(email);

-- Rate limit counters
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key TEXT NOT NULL,
    window_start INTEGER NOT NULL,            -- Unix epoch seconds at the start of the window
    count INTEGER NOT NULL,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);

-- Slack workspace members
CREATE TABLE IF NOT EXISTS slack_users (
    slack_id TEXT PRIMARY KEY,
    team_id TEXT,
    name TEXT,
    real_name TEXT,
    email TEXT,                                -- lowercased; NULL for bots and guests without one
    deleted INTEGER NOT NULL DEFAULT 0,        -- deactivated accounts stay listed by Slack, flagged here
    color TEXT,
    tz TEXT,
    tz_label TEXT,
    tz_offset INTEGER,
    profile TEXT,                              -- Slack's full `profile` object, as JSON
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_owner INTEGER NOT NULL DEFAULT 0,
    is_primary_owner INTEGER NOT NULL DEFAULT 0,
    is_restricted INTEGER NOT NULL DEFAULT 0,
    is_ultra_restricted INTEGER NOT NULL DEFAULT 0,
    is_bot INTEGER NOT NULL DEFAULT 0,
    is_app_user INTEGER NOT NULL DEFAULT 0,
    is_workflow_bot INTEGER NOT NULL DEFAULT 0,
    is_invited_user INTEGER NOT NULL DEFAULT 0,
    is_email_confirmed INTEGER NOT NULL DEFAULT 0,
    has_2fa INTEGER NOT NULL DEFAULT 0,
    who_can_share_contact_card TEXT,
    updated INTEGER,                           -- Slack's own last-changed time, epoch seconds
    synced_at INTEGER NOT NULL                 -- when the ETL last saw this row, epoch ms
);

CREATE INDEX IF NOT EXISTS idx_slack_users_email ON slack_users(email);

-- Membership order history
CREATE TABLE IF NOT EXISTS membership_orders (
    order_id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('bigcommerce', 'squarespace')),
    order_number TEXT,                         -- legacy display number (`{id}_{cart_id}` for BigCommerce)
    channel_name TEXT,                         -- e.g. bigcommerce_www, bigcommerce_iphone
    order_email TEXT NOT NULL,                 -- lowercased; the address given on the order itself
    member_email TEXT NOT NULL,                -- lowercased; who we currently consider the member (may differ from order_email)
    first_name TEXT,
    last_name TEXT,
    customer_id INTEGER,                       -- BigCommerce customer id; NULL for Squarespace
    sku TEXT,
    product_name TEXT,
    status TEXT,                               -- the store's own order status, verbatim (e.g. Completed, Refunded, CANCELED)
    created_on TEXT NOT NULL,                  -- start of the membership period
    expires_on TEXT NOT NULL,                  -- created_on + 365 days, stored so date-window queries can use an index
    modified_on TEXT,
    first_seen_via TEXT NOT NULL CHECK (first_seen_via IN ('sync', 'legacy_postgres')),
    -- When BigCommerce stopped returning this order.
    -- Flags it for a person; does not stop it counting as a membership.
    missing_since INTEGER,
    -- How many memberships the order contained. 1 is
    -- the invariant the storefront maintains; above 1 means someone paid for
    -- a membership no card exists for. NULL = never counted (legacy import).
    -- Flags it for a person; does not stop it counting as a membership.
    membership_units INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_membership_orders_order_email ON membership_orders(order_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_member_email ON membership_orders(member_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_window ON membership_orders(created_on, expires_on);
CREATE INDEX IF NOT EXISTS idx_membership_orders_missing ON membership_orders(missing_since);
CREATE INDEX IF NOT EXISTS idx_membership_orders_units ON membership_orders(membership_units);

-- Admin attributions of membership orders
CREATE TABLE IF NOT EXISTS membership_order_attributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES membership_orders(order_id),
    previous_member_email TEXT NOT NULL,       -- lowercased
    member_email TEXT NOT NULL,                -- lowercased; the new attribution
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_membership_order_attributions_order ON membership_order_attributions(order_id);

-- Card emails already sent for an order
CREATE TABLE IF NOT EXISTS card_emails (
    order_id TEXT PRIMARY KEY REFERENCES membership_orders(order_id),
    member_email TEXT NOT NULL,                -- lowercased; who it was sent to
    sent_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
