-- Slack workspace members, refreshed by the `run_slack_members_etl` job
-- (src/slack/membersEtl.ts). Ports the legacy app's `slack_user` table, whose
-- only consumer is membership reporting (los-verdes/card-losverd-es#53).
-- Additive-only, per this repo's migration house rule.
--
-- Column set mirrors the legacy table so existing report queries translate
-- directly. Differences: booleans are 0/1 INTEGERs, `updated`/`tz_offset`
-- are INTEGERs (Slack sends numbers; the legacy table stringified them), and
-- there is no `user_id` -- reports join to `members`/`users` by email, and the
-- ETL no longer creates a login `users` row per Slack member.
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
