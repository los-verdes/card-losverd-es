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
