-- Connecting a store account to a card-site user (#38). A store customer is
-- linked only when one browser proves both identities at once: a verified
-- storefront `current.jwt` and a Google or Apple sign-in here. Afterwards
-- `users.bigcommerce_id` (already in the schema, and empty everywhere when
-- this was written, 2026-09-30) is the only thing either direction reads.

ALTER TABLE users ADD COLUMN bigcommerce_linked_at INTEGER;

-- One store account belongs to one user: connecting it to a second is
-- refused rather than moved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bigcommerce_id ON users(bigcommerce_id) WHERE bigcommerce_id IS NOT NULL;

-- Storefront JWTs already used for a handoff, so each is accepted once: it is
-- a bearer token for its ~15 minutes. Kept until it would have expired, as a
-- SHA-256, never the token itself.
CREATE TABLE IF NOT EXISTS store_handoff_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_handoff_tokens_expires_at ON store_handoff_tokens(expires_at);
