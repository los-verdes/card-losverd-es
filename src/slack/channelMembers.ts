/**
 * Copies the members of each subgroup's Slack channel into
 * `slack_channel_members` (#333, piece 6): Los Pringles is whoever is in
 * `#los-pringles`, and may use its card theme.
 *
 * Runs after the workspace's user list (src/slack/membersEtl.ts), which is
 * what turns a member's Slack id into an address. Plain HTTP against Slack's
 * Web API, like that sync: `conversations.list` to find each channel by name,
 * then `conversations.members`, both cursor-paginated. The channels are
 * public, so the bot needs the `channels:read` scope and does not have to
 * join them.
 *
 * A channel's list is replaced only after it has been read in full: anyone
 * not seen in a complete read has left, and their row is removed. Someone who
 * left and had chosen that group's theme falls back to their default theme,
 * and their passes are told. When the channel cannot be read at all -- the
 * scope has not been granted yet, or no channel has that name -- this warns
 * and leaves the stored list alone, rather than emptying it and taking the
 * theme from everyone.
 */

import type { Env } from "../index";
import { CARD_THEMES, type CardTheme } from "../themes/cardTheme";
import { touchAndNotify } from "../themes/choice";
import { CARD_GROUPS, type CardGroup } from "../themes/groups";

export const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list";
export const SLACK_CONVERSATIONS_MEMBERS_URL = "https://slack.com/api/conversations.members";

/** Slack's own maximum page size for both methods. */
const PAGE_SIZE = 1000;
/** Backstop against a cursor that never ends. */
const MAX_PAGES = 200;

/** Errors that mean "this can't be read here", not "try again later". */
const UNREADABLE = new Set(["missing_scope", "channel_not_found", "not_in_channel", "not_allowed_token_type"]);

class SlackUnreadable extends Error {}

interface SlackPage {
  ok: boolean;
  error?: string;
  channels?: { id: string; name: string }[];
  members?: string[];
  response_metadata?: { next_cursor?: string };
}

async function slackGet(url: string, token: string, params: Record<string, string>): Promise<SlackPage> {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`Slack ${url} failed: HTTP ${res.status}${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ""}`);
  }
  const body = await res.json<SlackPage>();
  if (!body.ok) {
    const error = body.error ?? "unknown error";
    if (UNREADABLE.has(error)) throw new SlackUnreadable(error);
    throw new Error(`Slack ${url} failed: ${error}`);
  }
  return body;
}

/** Every page of one method, gathered; `pick` takes each page's items. */
async function allPages<T>(url: string, token: string, params: Record<string, string>, pick: (page: SlackPage) => T[]): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await slackGet(url, token, { ...params, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
    items.push(...pick(body));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) return items;
  }
  throw new Error(`Slack ${url}: gave up after ${MAX_PAGES} pages without reaching the end`);
}

/** The ids of the public channels with these names. */
async function channelIds(token: string, names: readonly string[]): Promise<Map<string, string>> {
  const channels = await allPages(
    SLACK_CONVERSATIONS_LIST_URL,
    token,
    { types: "public_channel", exclude_archived: "true" },
    (page) => page.channels ?? [],
  );
  return new Map(channels.filter((channel) => names.includes(channel.name)).map((channel) => [channel.name, channel.id]));
}

export interface ChannelSyncResult {
  channel: string;
  /** How many members the channel has, or null when it could not be read. */
  members: number | null;
  /** How many left since the last read. */
  removed: number;
}

/**
 * Reads each group's channel and rewrites its stored members. A no-op (with a
 * warning) until `SLACK_BOT_TOKEN` is set. Throws on a failure worth retrying,
 * so the queue retries; a channel that cannot be read here is skipped.
 */
export async function syncSlackChannelMembers(
  env: Env,
  groups: readonly CardGroup[] = CARD_GROUPS,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<ChannelSyncResult[]> {
  if (!env.SLACK_BOT_TOKEN) {
    console.warn("sync_slack_channel_members: SLACK_BOT_TOKEN is not set; skipping");
    return [];
  }
  const token = env.SLACK_BOT_TOKEN;
  let ids: Map<string, string>;
  try {
    ids = await channelIds(token, groups.map((group) => group.slackChannel));
  } catch (err) {
    if (!(err instanceof SlackUnreadable)) throw err;
    console.warn(`sync_slack_channel_members: cannot list channels (${err.message}); needs the channels:read scope. Skipping.`);
    return groups.map((group) => ({ channel: group.slackChannel, members: null, removed: 0 }));
  }

  const results: ChannelSyncResult[] = [];
  for (const group of groups) {
    const channel = group.slackChannel;
    const id = ids.get(channel);
    let members: string[];
    try {
      if (!id) throw new SlackUnreadable("channel_not_found");
      members = await allPages(SLACK_CONVERSATIONS_MEMBERS_URL, token, { channel: id }, (page) => page.members ?? []);
    } catch (err) {
      if (!(err instanceof SlackUnreadable)) throw err;
      console.warn(`sync_slack_channel_members: cannot read #${channel} (${err.message}); keeping its stored members.`);
      results.push({ channel, members: null, removed: 0 });
      continue;
    }

    const syncedAt = Date.now();
    const upsert = env.DB.prepare(
      `INSERT INTO slack_channel_members (channel_name, slack_id, synced_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_name, slack_id) DO UPDATE SET synced_at = excluded.synced_at`,
    );
    for (let i = 0; i < members.length; i += 100) {
      await env.DB.batch(members.slice(i, i + 100).map((slackId) => upsert.bind(channel, slackId, syncedAt)));
    }

    // Who left: their addresses, before their rows go.
    const { results: left } = await env.DB.prepare(
      `SELECT DISTINCT u.email FROM slack_channel_members c
         JOIN slack_users u ON u.slack_id = c.slack_id
        WHERE c.channel_name = ? AND c.synced_at < ? AND u.email IS NOT NULL`,
    )
      .bind(channel, syncedAt)
      .all<{ email: string }>();
    const pruned = await env.DB.prepare("DELETE FROM slack_channel_members WHERE channel_name = ? AND synced_at < ?")
      .bind(channel, syncedAt)
      .run();

    // A leaver who had chosen this group's theme is back to their default,
    // so their passes need to hear about it; nobody else's card has changed.
    const groupThemeIds = themes.filter((theme) => theme.group === group.id).map((theme) => theme.id);
    if (left.length > 0 && groupThemeIds.length > 0) {
      for (const { email } of left) {
        const chosen = await env.DB.prepare("SELECT theme_id FROM member_card_themes WHERE email = ?")
          .bind(email)
          .first<{ theme_id: string }>();
        if (chosen && groupThemeIds.includes(chosen.theme_id)) await touchAndNotify(env, email);
      }
    }

    results.push({ channel, members: members.length, removed: pruned.meta.changes ?? 0 });
  }
  console.log("sync_slack_channel_members: done", results);
  return results;
}
