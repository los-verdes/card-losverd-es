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
  /** The verdict an imported Squarespace-era row carries (`frozen_counts`); 1 unless given. */
  counted?: 0 | 1;
}

/**
 * Inserts a synthetic `membership_orders` row. `expires_on` is the same
 * moment a calendar year later, close enough to 365 days for these tests.
 * A Squarespace-era row carries a stored verdict, as every imported one does.
 */
export async function insertOrder(o: OrderFixture) {
  const expires = `${Number(o.created.slice(0, 4)) + 1}${o.created.slice(4)}`;
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, channel_name, order_email, member_email, first_name, last_name,
       status, created_on, expires_on, first_seen_via, frozen_counts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync', ?)`,
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
      o.source === "squarespace" ? (o.counted ?? 1) : null,
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

/** A synthetic `members` row carrying the name and date the orders gave it. */
export async function insertMember(m: { id: string; email: string; first: string; last: string; memberSince: string | null }) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, member_since, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, 'token', 1)`,
  )
    .bind(m.id, m.first, m.last, m.email, m.memberSince)
    .run();
}

/** A card name set by hand, as the member page or the legacy import writes it. */
export async function insertCardName(o: { email: string; name: string; source: "member" | "admin" | "legacy_postgres"; setBy?: number; note?: string; at: number }) {
  await env.DB.prepare(
    "INSERT INTO member_display_names (email, display_name, source, note, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(o.email, o.name, o.source, o.note ?? null, o.setBy ?? null, o.at)
    .run();
}

/** A corrected "member since", as the admin page or the legacy import writes it. */
export async function insertMemberSince(o: { email: string; date: string; source: "manual" | "legacy_postgres"; setBy?: number; note?: string; at: number }) {
  await env.DB.prepare(
    "INSERT INTO member_since_overrides (email, member_since, source, note, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(o.email, o.date, o.source, o.note ?? null, o.setBy ?? null, o.at)
    .run();
}
