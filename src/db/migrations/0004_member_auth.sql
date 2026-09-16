-- Member authentication tables, per the migration plan's Phase 2.1/2.3.
-- Additive-only, per this repo's migration house rule.

-- Login identities -- independent of membership/pass state: a user can
-- exist before ever buying a membership, exactly as the legacy app's
-- flask-security `User` can.
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

-- Linked OAuth provider identities (Google / Apple / Yahoo) -- replaces
-- python-social-auth's UserSocialAuth table.
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

-- Linked login identity for a member, once they've authenticated. Nullable:
-- membership rows are created by BigCommerce order sync, usually before any
-- login happens.
ALTER TABLE members ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
