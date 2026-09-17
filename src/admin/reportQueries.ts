/**
 * SQL behind the admin membership reports (src/admin/reports.tsx), all over
 * `membership_orders` (migration 0008). Kept apart from the pages so the HTML
 * table and the CSV download of a report always run the same query.
 *
 * Timestamps in the table are ISO8601 UTC text, so "was a member at instant
 * T" is `created_on <= T AND expires_on > T` -- plain string comparison, and
 * what `idx_membership_orders_window` exists for.
 */

import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";

export interface ReportFilters {
  /** Matches anywhere in either email or the billing name; case-insensitive. */
  search?: string;
  /** Exact `channel_name`, e.g. `bigcommerce_www`. */
  channel?: string;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface MembershipOrderRow {
  [key: string]: string | null;
  order_id: string;
  first_name: string | null;
  last_name: string | null;
  order_email: string;
  member_email: string;
  created_on: string;
  expires_on: string;
  channel_name: string | null;
  source: string;
  status: string | null;
}

const ORDER_COLUMNS =
  "order_id, first_name, last_name, order_email, member_email, created_on, expires_on, channel_name, source, status";

/** Escapes LIKE wildcards so a search for `a_b` doesn't match `axb`. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Extra WHERE clauses for the shared filters, numbered from `firstParam`. */
function filterClauses(
  filters: ReportFilters,
  firstParam: number,
): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const search = filters.search?.trim();
  if (search) {
    params.push(likePattern(search));
    const p = `?${firstParam + params.length - 1}`;
    clauses.push(
      `(order_email LIKE ${p} ESCAPE '\\' OR member_email LIKE ${p} ESCAPE '\\' ` +
        `OR (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ${p} ESCAPE '\\')`,
    );
  }
  if (filters.channel) {
    params.push(filters.channel);
    clauses.push(`channel_name = ?${firstParam + params.length - 1}`);
  }
  return { sql: clauses.map((c) => ` AND ${c}`).join(""), params };
}

export interface ActiveMembershipsResult {
  rows: MembershipOrderRow[];
  /** Matching orders, ignoring paging. */
  totalOrders: number;
  /** Distinct members among them (someone who renewed early has two orders). */
  totalMembers: number;
}

/** Every membership order in force at `asOf`, newest first. */
export async function activeMemberships(
  db: D1Database,
  asOf: string,
  filters: ReportFilters = {},
  page?: Page,
): Promise<ActiveMembershipsResult> {
  const extra = filterClauses(filters, 2);
  const where = `created_on <= ?1 AND expires_on > ?1 AND ${COUNTS_AS_MEMBERSHIP}${extra.sql}`;
  const paging = page ? ` LIMIT ${Number(page.limit)} OFFSET ${Number(page.offset)}` : "";
  const [list, totals] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT ${ORDER_COLUMNS} FROM membership_orders WHERE ${where} ORDER BY created_on DESC, order_id${paging}`,
      )
      .bind(asOf, ...extra.params),
    db
      .prepare(
        `SELECT COUNT(*) AS orders, COUNT(DISTINCT member_email) AS members FROM membership_orders WHERE ${where}`,
      )
      .bind(asOf, ...extra.params),
  ]);
  const counts = totals.results[0] as { orders: number; members: number };
  return {
    rows: list.results as unknown as MembershipOrderRow[],
    totalOrders: counts.orders,
    totalMembers: counts.members,
  };
}

export interface ExpiredMembershipsResult {
  rows: MembershipOrderRow[];
  total: number;
}

/**
 * Lapsed members as of `asOf`: each member's most recent membership order,
 * where that order had already expired and they held nothing in force.
 *
 * Grouped by `member_email` rather than the legacy report's order email, so
 * someone who renewed under a new address isn't listed as lapsed under the
 * old one. (For orders first seen via the sync the two are the same.)
 */
export async function expiredMemberships(
  db: D1Database,
  asOf: string,
  filters: ReportFilters = {},
  page?: Page,
): Promise<ExpiredMembershipsResult> {
  const extra = filterClauses(filters, 2);
  // SQLite's bare-column rule: with a single MAX() aggregate, the other
  // selected columns come from the row that holds the maximum.
  const latest = `
    SELECT ${ORDER_COLUMNS}, MAX(expires_on) AS latest_expiry
    FROM membership_orders
    WHERE created_on <= ?1 AND ${COUNTS_AS_MEMBERSHIP}
    GROUP BY member_email
    HAVING latest_expiry <= ?1`;
  const paging = page ? ` LIMIT ${Number(page.limit)} OFFSET ${Number(page.offset)}` : "";
  const [list, totals] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT ${ORDER_COLUMNS} FROM (${latest}) WHERE 1 = 1${extra.sql} ORDER BY expires_on DESC, order_id${paging}`,
      )
      .bind(asOf, ...extra.params),
    db
      .prepare(`SELECT COUNT(*) AS n FROM (${latest}) WHERE 1 = 1${extra.sql}`)
      .bind(asOf, ...extra.params),
  ]);
  return {
    rows: list.results as unknown as MembershipOrderRow[],
    total: (totals.results[0] as { n: number }).n,
  };
}

export interface MonthlyOrders {
  [key: string]: string | number;
  /** `01`..`12`. */
  month: string;
  orders: number;
  previous_year_orders: number;
}

/** Membership orders per calendar month (UTC) for `year` and the year before. */
export async function ordersByMonth(
  db: D1Database,
  year: number,
): Promise<MonthlyOrders[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(created_on, 6, 2) AS month,
              SUM(substr(created_on, 1, 4) = ?1) AS orders,
              SUM(substr(created_on, 1, 4) = ?2) AS previous_year_orders
       FROM membership_orders
       WHERE substr(created_on, 1, 4) IN (?1, ?2) AND ${COUNTS_AS_MEMBERSHIP}
       GROUP BY month`,
    )
    .bind(String(year), String(year - 1))
    .all<MonthlyOrders>();
  const byMonth = new Map(results.map((row) => [row.month, row]));
  return Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, "0");
    return byMonth.get(month) ?? { month, orders: 0, previous_year_orders: 0 };
  });
}

export interface SlackCrossReferenceRow {
  [key: string]: string | null;
  email: string;
  /** Billing name on the member's latest-expiring order; null for Slack users with none. */
  first_name: string | null;
  last_name: string | null;
  /** When that latest order expires (or expired). */
  expires_on: string | null;
  slack_id: string | null;
  /** Slack's full name, falling back to the handle. */
  slack_name: string | null;
}

export interface SlackCrossReference {
  currentInSlack: SlackCrossReferenceRow[];
  currentNotInSlack: SlackCrossReferenceRow[];
  lapsedInSlack: SlackCrossReferenceRow[];
  slackWithoutOrders: SlackCrossReferenceRow[];
  /** Newest `slack_users.synced_at` (epoch ms), or null if the sync has never run. */
  slackSyncedAt: number | null;
}

/**
 * Membership orders cross-referenced with Slack accounts by lowercased email,
 * as of `asOf`. "Current" and "lapsed" match the active and expired reports:
 * a member is current if their latest-expiring membership order placed by
 * `asOf` is still in force, and lapsed otherwise. Slack users "without
 * orders" have no membership order (void and test orders don't count) placed
 * by `asOf` under their email.
 *
 * Only live human accounts count as being in Slack: deactivated accounts
 * (`deleted = 1`), bots and apps are ignored, as are accounts with no email,
 * which can't be matched (Slackbot is one). Guests and pending invites count.
 */
export async function slackCrossReference(
  db: D1Database,
  asOf: string,
): Promise<SlackCrossReference> {
  // Bare-column rule again: names come from the latest-expiring order.
  const ctes = `
    WITH memberships AS (
      SELECT lower(member_email) AS email, first_name, last_name, MAX(expires_on) AS expires_on
      FROM membership_orders
      WHERE created_on <= ?1 AND ${COUNTS_AS_MEMBERSHIP}
      GROUP BY lower(member_email)
    ),
    slack AS (
      SELECT slack_id, COALESCE(NULLIF(real_name, ''), name) AS slack_name, lower(email) AS email
      FROM slack_users
      WHERE deleted = 0 AND is_bot = 0 AND is_app_user = 0 AND is_workflow_bot = 0 AND email IS NOT NULL
    )`;
  const inSlack = `SELECT m.email, m.first_name, m.last_name, m.expires_on, s.slack_id, s.slack_name
    FROM memberships m JOIN slack s ON s.email = m.email`;
  const [currentIn, currentNotIn, lapsedIn, slackOnly, synced] = await db.batch<Record<string, unknown>>([
    db.prepare(`${ctes} ${inSlack} WHERE m.expires_on > ?1 ORDER BY m.email, s.slack_id`).bind(asOf),
    db
      .prepare(
        `${ctes} SELECT email, first_name, last_name, expires_on, NULL AS slack_id, NULL AS slack_name
         FROM memberships m
         WHERE expires_on > ?1 AND NOT EXISTS (SELECT 1 FROM slack s WHERE s.email = m.email)
         ORDER BY email`,
      )
      .bind(asOf),
    db.prepare(`${ctes} ${inSlack} WHERE m.expires_on <= ?1 ORDER BY m.expires_on DESC, m.email, s.slack_id`).bind(asOf),
    db
      .prepare(
        `${ctes} SELECT email, NULL AS first_name, NULL AS last_name, NULL AS expires_on, slack_id, slack_name
         FROM slack s
         WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.email = s.email)
         ORDER BY email, slack_id`,
      )
      .bind(asOf),
    db.prepare("SELECT MAX(synced_at) AS synced_at FROM slack_users"),
  ]);
  const rows = (result: D1Result<Record<string, unknown>>) =>
    result.results as unknown as SlackCrossReferenceRow[];
  return {
    currentInSlack: rows(currentIn),
    currentNotInSlack: rows(currentNotIn),
    lapsedInSlack: rows(lapsedIn),
    slackWithoutOrders: rows(slackOnly),
    slackSyncedAt: (synced.results[0] as { synced_at: number | null }).synced_at,
  };
}

/** Distinct channels, for the filter dropdown. */
export async function listChannels(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT channel_name FROM membership_orders WHERE channel_name IS NOT NULL ORDER BY channel_name",
    )
    .all<{ channel_name: string }>();
  return results.map((row) => row.channel_name);
}
