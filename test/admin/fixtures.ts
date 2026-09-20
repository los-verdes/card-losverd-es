import { env } from "cloudflare:test";

export interface OrderFixture {
  id: string;
  email: string;
  memberEmail?: string;
  first?: string;
  last?: string;
  created: string;
  status?: string | null;
  channel?: string | null;
  source?: "bigcommerce" | "squarespace";
}

/**
 * Inserts a synthetic `membership_orders` row. `expires_on` is the same
 * moment a calendar year later, close enough to 365 days for these tests.
 */
export async function insertOrder(o: OrderFixture) {
  const expires = `${Number(o.created.slice(0, 4)) + 1}${o.created.slice(4)}`;
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, channel_name, order_email, member_email, first_name, last_name,
       status, created_on, expires_on, first_seen_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync')`,
  )
    .bind(
      o.id,
      o.source ?? "bigcommerce",
      o.channel === undefined ? "bigcommerce_www" : o.channel,
      o.email,
      o.memberEmail ?? o.email,
      o.first ?? "Test",
      o.last ?? "Member",
      o.status === undefined ? "Completed" : o.status,
      o.created,
      expires,
    )
    .run();
}

export interface SlackUserFixture {
  id: string;
  email: string | null;
  realName?: string;
  deleted?: boolean;
  isBot?: boolean;
  isAppUser?: boolean;
  isWorkflowBot?: boolean;
  syncedAt?: number;
}

/** Inserts a synthetic `slack_users` row; the handle is the lowercased id. */
export async function insertSlackUser(u: SlackUserFixture) {
  await env.DB.prepare(
    `INSERT INTO slack_users (slack_id, name, real_name, email, deleted, is_bot, is_app_user, is_workflow_bot, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      u.id,
      u.id.toLowerCase(),
      u.realName ?? "",
      u.email,
      u.deleted ? 1 : 0,
      u.isBot ? 1 : 0,
      u.isAppUser ? 1 : 0,
      u.isWorkflowBot ? 1 : 0,
      u.syncedAt ?? Date.UTC(2026, 5, 1),
    )
    .run();
}
