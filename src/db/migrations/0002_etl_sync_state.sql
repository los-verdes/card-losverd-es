-- ETL Sync State (watermarks for scheduled BigCommerce/MiniBC resync jobs --
-- see docs/bigcommerce-ingestion.md)
CREATE TABLE IF NOT EXISTS etl_sync_state (
    job_name TEXT PRIMARY KEY,                -- e.g. 'sync_subscriptions_etl'
    last_run_at INTEGER NOT NULL,             -- Unix epoch (ms) of the last successful run start
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
