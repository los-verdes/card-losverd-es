/**
 * The subgroups whose members get a card theme of their own (#333, piece 6).
 *
 * A subgroup is a public Slack channel: Los Pringles is whoever is in
 * `#los-pringles`. The Slack sync copies each channel's members into
 * `slack_channel_members` (src/slack/channelMembers.ts), and a member belongs
 * to a group while the Slack account with their address is in its channel.
 *
 * Defined here rather than in a table, like the themes themselves, so adding
 * one is a reviewed change.
 */

import type { Env } from "../index";

export interface CardGroup {
  /** Stable identifier, named by a group theme's `group`. */
  id: string;
  label: string;
  /** The public Slack channel whose members are the group, without the `#`. */
  slackChannel: string;
}

export const CARD_GROUPS: readonly CardGroup[] = [
  { id: "los-pringles", label: "Los Pringles", slackChannel: "los-pringles" },
  { id: "verdirojas", label: "Verdirojas", slackChannel: "verdirojas" },
];

/**
 * The groups this address belongs to: any whose channel holds a current
 * (not deactivated) Slack account with this address. Matched on the address,
 * as Slack accounts are matched to memberships everywhere else.
 */
export async function groupsFor(
  env: Env,
  email: string,
  groups: readonly CardGroup[] = CARD_GROUPS,
): Promise<Set<string>> {
  if (groups.length === 0) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT c.channel_name
       FROM slack_channel_members c
       JOIN slack_users u ON u.slack_id = c.slack_id
      WHERE u.email = ? AND u.deleted = 0`,
  )
    .bind(email.trim().toLowerCase())
    .all<{ channel_name: string }>();
  const channels = new Set(results.map((row) => row.channel_name));
  return new Set(groups.filter((group) => channels.has(group.slackChannel)).map((group) => group.id));
}
