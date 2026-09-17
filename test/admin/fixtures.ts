import { env } from "cloudflare:test";

export interface OrderFixture {
  id: string;
  email: string;
  memberEmail?: string;
  first?: string;
  last?: string;
  created: string;
  status?: string | null;
  testMode?: boolean;
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
       status, test_mode, created_on, expires_on, first_seen_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync')`,
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
      o.testMode ? 1 : 0,
      o.created,
      expires,
    )
    .run();
}
