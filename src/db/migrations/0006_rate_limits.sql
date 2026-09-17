-- Fixed-window request counters for abuse-prone endpoints (src/lib/rateLimit.ts),
-- e.g. the no-login email card form. `key` is the limit's name plus a SHA-256
-- hash of the subject (IP address, email address), so no raw PII is stored.
-- Rows for expired windows are purged opportunistically.
-- Additive-only, per this repo's migration house rule.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key TEXT NOT NULL,
    window_start INTEGER NOT NULL,            -- Unix epoch seconds at the start of the window
    count INTEGER NOT NULL,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);
