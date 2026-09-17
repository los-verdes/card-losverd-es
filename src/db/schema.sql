-- Members / Pass Holders Table
CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY,               -- e.g. LV-10023 or UUID
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    membership_tier TEXT NOT NULL DEFAULT 'standard', -- e.g. standard, los-pringles, cut-crew, etc.
    status TEXT NOT NULL DEFAULT 'active',    -- active, expired, revoked
    expiration_date TEXT,                     -- ISO8601 string (YYYY-MM-DD)
    member_since TEXT,                        -- ISO8601 string (YYYY-MM-DD); see migrations/0003_member_since.sql
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- linked login identity, if any; see migrations/0004_member_auth.sql
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

-- Login Identities (see migrations/0004_member_auth.sql)
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

-- Linked OAuth Provider Identities (see migrations/0004_member_auth.sql)
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

-- Member-since overrides + legacy cards (see migrations/0005_legacy_export.sql,
-- including the triggers that bump members.last_updated_at on override changes)
CREATE TABLE IF NOT EXISTS member_since_overrides (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    member_since TEXT NOT NULL,               -- ISO8601 date (YYYY-MM-DD); wins over members.member_since
    source TEXT NOT NULL CHECK (source IN ('legacy_postgres', 'manual')),
    note TEXT,
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

-- Rate limit counters (see migrations/0006_rate_limits.sql)
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key TEXT NOT NULL,
    window_start INTEGER NOT NULL,            -- Unix epoch seconds at the start of the window
    count INTEGER NOT NULL,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);

-- Slack workspace members (see migrations/0007_slack_users.sql)
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

-- Membership order history (see migrations/0008_membership_orders.sql)
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
    test_mode INTEGER NOT NULL DEFAULT 0,      -- Squarespace's test-order flag; always 0 for BigCommerce
    created_on TEXT NOT NULL,                  -- start of the membership period
    expires_on TEXT NOT NULL,                  -- created_on + 365 days, stored so date-window queries can use an index
    modified_on TEXT,
    first_seen_via TEXT NOT NULL CHECK (first_seen_via IN ('sync', 'legacy_postgres')),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_membership_orders_order_email ON membership_orders(order_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_member_email ON membership_orders(member_email);
CREATE INDEX IF NOT EXISTS idx_membership_orders_window ON membership_orders(created_on, expires_on);
