/**
 * Slack members ETL: copies the workspace's user list into D1's
 * `slack_users` table. Ports the legacy app's `member_card/slack.py`, whose
 * output feeds membership reporting (los-verdes/card-losverd-es#53).
 *
 * Plain HTTP against Slack's Web API rather than an SDK -- one endpoint
 * (`users.list`), cursor-paginated.
 *
 * Deliberate differences from the legacy job:
 * - It doesn't create an app `users` row per Slack member. In this stack
 *   `users` holds login identities only; reports join on email instead.
 * - No sleep between pages. `users.list` is rate-limit Tier 2 (20+/min), and
 *   at 200 members a page that is thousands of members per run. A 429 throws,
 *   and the `etl-sync` queue's retry backoff does the waiting.
 *
 * Deactivated members need no special handling: Slack keeps listing them
 * with `deleted: true`, so the upsert alone keeps the table accurate.
 *
 * Members who stop being listed altogether do need handling, and get it: a
 * completed run deletes every row it didn't just write. The table is a copy
 * of one workspace's user list, so anything the workspace no longer reports
 * is not a member of it. That matters most when the *token* changes rather
 * than the workspace -- pointing an environment at a different Slack app
 * would otherwise leave the previous workspace's people in the table
 * indefinitely, counted as current by the reports, which never filter on
 * `team_id` (los-verdes/card-losverd-es#133).
 */

import type { Env } from "../index";

export const SLACK_USERS_LIST_URL = "https://slack.com/api/users.list";

/** Slack recommends no more than 200 per page for `users.list`. */
const PAGE_SIZE = 200;

/**
 * Backstop against a cursor that never terminates (200,000 members' worth);
 * also keeps a run well inside the 1,000-subrequest limit.
 */
const MAX_PAGES = 1000;

/** The fields of Slack's user object that `slack_users` keeps. */
export interface SlackMember {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  color?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile?: { email?: string } & Record<string, unknown>;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_workflow_bot?: boolean;
  is_invited_user?: boolean;
  is_email_confirmed?: boolean;
  has_2fa?: boolean;
  who_can_share_contact_card?: string;
  updated?: number;
}

interface UsersListResponse {
  ok: boolean;
  error?: string;
  members?: SlackMember[];
  response_metadata?: { next_cursor?: string };
}

/** One page of `users.list`; `nextCursor` is empty on the last page. */
export async function fetchSlackMembersPage(
  botToken: string,
  cursor: string,
): Promise<{ members: SlackMember[]; nextCursor: string }> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) {
    query.set("cursor", cursor);
  }
  const res = await fetch(`${SLACK_USERS_LIST_URL}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(
      `Slack users.list failed: HTTP ${res.status}` +
        (retryAfter ? ` (Retry-After: ${retryAfter}s)` : ""),
    );
  }
  // Slack reports most failures (bad token, missing scope) as HTTP 200 with
  // `ok: false`.
  const body = await res.json<UsersListResponse>();
  if (!body.ok) {
    throw new Error(`Slack users.list failed: ${body.error ?? "unknown error"}`);
  }
  return {
    members: body.members ?? [],
    nextCursor: body.response_metadata?.next_cursor ?? "",
  };
}

const UPSERT_SQL = `
INSERT INTO slack_users (
  slack_id, team_id, name, real_name, email, deleted, color, tz, tz_label,
  tz_offset, profile, is_admin, is_owner, is_primary_owner, is_restricted,
  is_ultra_restricted, is_bot, is_app_user, is_workflow_bot, is_invited_user,
  is_email_confirmed, has_2fa, who_can_share_contact_card, updated, synced_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
)
ON CONFLICT(slack_id) DO UPDATE SET
  team_id = excluded.team_id,
  name = excluded.name,
  real_name = excluded.real_name,
  email = excluded.email,
  deleted = excluded.deleted,
  color = excluded.color,
  tz = excluded.tz,
  tz_label = excluded.tz_label,
  tz_offset = excluded.tz_offset,
  profile = excluded.profile,
  is_admin = excluded.is_admin,
  is_owner = excluded.is_owner,
  is_primary_owner = excluded.is_primary_owner,
  is_restricted = excluded.is_restricted,
  is_ultra_restricted = excluded.is_ultra_restricted,
  is_bot = excluded.is_bot,
  is_app_user = excluded.is_app_user,
  is_workflow_bot = excluded.is_workflow_bot,
  is_invited_user = excluded.is_invited_user,
  is_email_confirmed = excluded.is_email_confirmed,
  has_2fa = excluded.has_2fa,
  who_can_share_contact_card = excluded.who_can_share_contact_card,
  updated = excluded.updated,
  synced_at = excluded.synced_at
`;

const flag = (value: boolean | undefined): number => (value ? 1 : 0);

/** Positional bind values for `UPSERT_SQL`, in column order. */
export function slackMemberRow(
  member: SlackMember,
  syncedAt: number,
): (string | number | null)[] {
  return [
    member.id,
    member.team_id ?? null,
    member.name ?? null,
    member.real_name ?? null,
    member.profile?.email?.trim().toLowerCase() || null,
    flag(member.deleted),
    member.color ?? null,
    member.tz ?? null,
    member.tz_label ?? null,
    member.tz_offset ?? null,
    member.profile ? JSON.stringify(member.profile) : null,
    flag(member.is_admin),
    flag(member.is_owner),
    flag(member.is_primary_owner),
    flag(member.is_restricted),
    flag(member.is_ultra_restricted),
    flag(member.is_bot),
    flag(member.is_app_user),
    flag(member.is_workflow_bot),
    flag(member.is_invited_user),
    flag(member.is_email_confirmed),
    flag(member.has_2fa),
    member.who_can_share_contact_card ?? null,
    member.updated ?? null,
    syncedAt,
  ];
}

/**
 * Runs the full sync and returns how many members were processed. A no-op
 * (with a warning) until the `SLACK_BOT_TOKEN` secret is set. Throws on any
 * Slack or D1 failure so the queue consumer retries; pages already written
 * stay written, which is harmless because the upsert is idempotent.
 */
export async function runSlackMembersEtl(env: Env): Promise<number> {
  if (!env.SLACK_BOT_TOKEN) {
    console.warn("run_slack_members_etl: SLACK_BOT_TOKEN is not set; skipping");
    return 0;
  }
  const syncedAt = Date.now();
  const upsert = env.DB.prepare(UPSERT_SQL);
  let cursor = "";
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { members, nextCursor } = await fetchSlackMembersPage(
      env.SLACK_BOT_TOKEN,
      cursor,
    );
    if (members.length > 0) {
      // One round trip (and one transaction) per page.
      await env.DB.batch(
        members.map((member) =>
          upsert.bind(...slackMemberRow(member, syncedAt)),
        ),
      );
      total += members.length;
    }
    if (!nextCursor) {
      // Only after a complete run: the loop throws rather than returning
      // early, so reaching here means the whole list was read. Skipped
      // entirely when the list came back empty -- a token that can no longer
      // see anyone should leave the table alone rather than empty it.
      let removed = 0;
      if (total > 0) {
        const pruned = await env.DB.prepare(
          "DELETE FROM slack_users WHERE synced_at < ?",
        )
          .bind(syncedAt)
          .run();
        removed = pruned.meta.changes ?? 0;
      }
      console.log("run_slack_members_etl: done", { members: total, removed });
      return total;
    }
    cursor = nextCursor;
  }
  throw new Error(
    `run_slack_members_etl: gave up after ${MAX_PAGES} pages without reaching the end`,
  );
}
