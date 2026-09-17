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

/** Distinct channels, for the filter dropdown. */
export async function listChannels(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT channel_name FROM membership_orders WHERE channel_name IS NOT NULL ORDER BY channel_name",
    )
    .all<{ channel_name: string }>();
  return results.map((row) => row.channel_name);
}
