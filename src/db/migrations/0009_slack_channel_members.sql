-- Who is in each Slack channel that stands for a subgroup (#333): Los Pringles
-- is whoever is in #los-pringles, and its members may use its card theme.
-- A copy of Slack's own list, rewritten by the Slack sync
-- (src/slack/channelMembers.ts), which prunes anyone who has left. Keyed on
-- the channel's name, as the groups are defined (src/themes/groups.ts), and
-- on the Slack account, which `slack_users` matches to an address.
CREATE TABLE IF NOT EXISTS slack_channel_members (
    channel_name TEXT NOT NULL,
    slack_id TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (channel_name, slack_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_channel_members_slack_id ON slack_channel_members(slack_id);
