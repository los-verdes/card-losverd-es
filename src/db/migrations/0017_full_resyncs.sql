-- One row per full BigCommerce resync (`just etl-run <env> full-resync`, or
-- the weekly cron), so the readiness page can say how far one has got and
-- how the last one ended without anybody reading Workers Logs or the queue.
--
-- A full resync is a chain of queue messages: first the store's order list,
-- page by page, then a re-read of each order held here that the list did not
-- return. Each message updates its row, keyed by the chain's start, so a
-- running row shows progress and `updated_at` says whether it is still moving.
-- Counts only; nothing here identifies a person or an order.
CREATE TABLE IF NOT EXISTS full_resyncs (
    started_at INTEGER PRIMARY KEY,           -- the chain's start (epoch ms), the same in every message
    orders_read INTEGER NOT NULL DEFAULT 0,   -- membership orders read from the store's list
    cards_changed INTEGER NOT NULL DEFAULT 0, -- of those, how many changed a card
    listed_at INTEGER,                        -- when the list was read to its end; NULL while it is being read
    rechecked INTEGER,                        -- orders the list did not return, re-read so far
    flagged INTEGER,                          -- of those, how many are newly gone from the store
    finished_at INTEGER,                      -- when the re-reads ended, and with them the resync
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
