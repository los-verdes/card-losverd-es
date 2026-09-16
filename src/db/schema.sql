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

-- Legacy Postgres exports (see migrations/0005_legacy_export.sql)
CREATE TABLE IF NOT EXISTS legacy_member_since (
    email TEXT PRIMARY KEY,                   -- lower-cased, matching members.email
    member_since TEXT NOT NULL                -- ISO8601 date (YYYY-MM-DD)
);

CREATE TABLE IF NOT EXISTS legacy_membership_cards (
    serial_number TEXT PRIMARY KEY,           -- legacy card UUID, lower-case hyphenated form (as in the QR URL)
    email TEXT NOT NULL,                      -- lower-cased card holder email
    full_name TEXT,
    member_since TEXT,                        -- ISO8601 date (YYYY-MM-DD)
    member_until TEXT                         -- ISO8601 date (YYYY-MM-DD)
);

CREATE INDEX IF NOT EXISTS idx_legacy_membership_cards_email ON legacy_membership_cards(email);
