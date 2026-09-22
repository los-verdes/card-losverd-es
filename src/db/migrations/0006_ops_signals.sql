-- Counting the things an hourly watch has to reason about, and remembering
-- what it has already said about them (#56).
--
-- `ops_events` is a tally, not a log: one row per notable failure, with a
-- category and at most a short detail, so a signal can ask "how many in the
-- last hour" without reading Workers Logs (which would need an API token in
-- the Worker). The watch prunes it, so it stays small and holds nothing for
-- long. Nothing here identifies a person -- the same rule the outcome lines
-- follow (src/lib/outcome.ts).
--
-- `ops_alert_state` is what keeps the watch quiet: which signals are firing,
-- since when, how many runs in a row, and when something was last said about
-- them. Without it an hourly job that finds a stale cron says so hourly.
CREATE TABLE IF NOT EXISTS ops_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                       -- a closed vocabulary; see src/ops/events.ts
    detail TEXT,                              -- short and categorical, never a person
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ops_events_kind_time ON ops_events(kind, occurred_at);

CREATE TABLE IF NOT EXISTS ops_alert_state (
    signal TEXT PRIMARY KEY,
    consecutive INTEGER NOT NULL DEFAULT 0,   -- runs in a row this signal has been firing
    firing_since INTEGER,                     -- epoch ms of the first of those runs
    last_alerted_at INTEGER                   -- epoch ms of the last thing said in Slack
);
