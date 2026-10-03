/**
 * Admin-only membership reports, replacing the legacy Google Data Studio
 * report that read Cloud SQL directly (los-verdes/card-losverd-es#53).
 * Server-rendered tables over `membership_orders`, each downloadable as CSV
 * and sortable by any column in the browser.
 *
 * Every response is `no-store`: these pages list members' names and emails.
 */

import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { toIsoSeconds } from "../bigcommerce/orders";
import { MEMBERSHIP_PRODUCTS } from "../bigcommerce/sync";
import { formatShortDate, parseIsoDate } from "../lib/dateFormat";
import type { Env } from "../index";
import { toCsv } from "../lib/csv";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, MemberLink, cellStyle } from "./layout";
import { BarChart, type BarGroup, type BarSeries } from "./barChart";
import { LineChart, type LineSeries } from "./lineChart";
import { activeMembersByDay } from "./membersOverTime";
import { OrderLink } from "./orders";
import { StoreCustomerLink, StoreOrderLink } from "./storeLinks";
import { When, sortKey } from "./when";
import { splitLapsedByRenewal, type LapsedByRenewal } from "./slackRenewals";
import { allRenewals, lastRenewalsRead, renewalState, renewalText, type RenewalRow, type RenewalState } from "../minibc/renewals";
import {
  activeMemberships,
  attentionCounts,
  consolidations,
  countedMembershipOrders,
  expiredMemberships,
  listChannels,
  missingOrders,
  extraMembershipOrdersSetAside,
  ordersWithExtraMemberships,
  ordersByDay,
  ordersByYearAndProduct,
  slackCrossReference,
  type AttentionCounts,
  type Consolidations,
  type AttributedOrderRow,
  type CardNameOverrideRow,
  type MemberSinceOverrideRow,
  type MembershipOrderRow,
  type ExtraMembershipOrderRow,
  type MissingOrderRow,
  type ReportFilters,
  type SlackCrossReference,
} from "./reportQueries";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ORDER_CSV_COLUMNS = [
  "order_id",
  "first_name",
  "last_name",
  "order_email",
  "member_email",
  "created_on",
  "expires_on",
  "channel_name",
  "source",
  "status",
] as const;

const SLACK_COLUMN_HEADINGS = {
  email: "Email",
  first_name: "First name",
  last_name: "Last name",
  expires_on: "Membership expires",
  slack_id: "Slack ID",
  slack_name: "Slack name",
  renewal: "Automatic renewal",
};

type SlackColumn = keyof typeof SLACK_COLUMN_HEADINGS;

const MEMBER_COLUMNS: SlackColumn[] = ["email", "first_name", "last_name", "expires_on"];
const SLACK_COLUMNS: SlackColumn[] = ["slack_id", "slack_name"];

/**
 * The Slack page's four tables; `key` names each one's CSV download.
 * `members` says whether its addresses belong to members, and so link to
 * them; the last table's are Slack accounts with no orders, which the
 * members page would only report as unknown. Where MiniBC is read, the
 * lapsed table is shown split three ways (`LAPSED_BY_RENEWAL`), and its own
 * download still has all of them.
 */
const SLACK_TABLES: {
  key: string;
  field: Exclude<keyof SlackCrossReference, "slackSyncedAt">;
  title: string;
  columns: SlackColumn[];
  members: boolean;
}[] = [
  { key: "current-in-slack", field: "currentInSlack", title: "Current members in Slack", columns: [...MEMBER_COLUMNS, ...SLACK_COLUMNS], members: true },
  { key: "current-not-in-slack", field: "currentNotInSlack", title: "Current members not in Slack", columns: MEMBER_COLUMNS, members: true },
  { key: "lapsed-in-slack", field: "lapsedInSlack", title: "Lapsed members in Slack", columns: [...MEMBER_COLUMNS, ...SLACK_COLUMNS], members: true },
  { key: "users-without-orders", field: "slackWithoutOrders", title: "Slack users with no membership orders", columns: ["email", ...SLACK_COLUMNS], members: false },
];

/** "Lapsed members in Slack", by what MiniBC says about their renewal (src/admin/slackRenewals.ts). */
const LAPSED_BY_RENEWAL: { key: string; field: keyof LapsedByRenewal; title: string }[] = [
  { key: "lapsed-in-slack-renewal-on", field: "renewalOn", title: "Lapsed members in Slack, automatic renewal still on" },
  { key: "lapsed-in-slack-renewal-off", field: "renewalOff", title: "Lapsed members in Slack, automatic renewal cancelled or paused" },
  { key: "lapsed-in-slack-no-renewal", field: "noRenewal", title: "Lapsed members in Slack, never renewed automatically" },
];

interface ShownSlackTable {
  key: string;
  title: string;
  columns: SlackColumn[];
  members: boolean;
  rows: Record<string, string | null>[];
}

/** The tables the page shows, in order: the lapsed one split when MiniBC's renewals are known. */
function slackTables(result: SlackCrossReference, lapsed: LapsedByRenewal | null): ShownSlackTable[] {
  return SLACK_TABLES.flatMap((table): ShownSlackTable[] => {
    if (table.field === "lapsedInSlack" && lapsed) {
      return LAPSED_BY_RENEWAL.map((group) => ({
        key: group.key,
        title: group.title,
        columns: [...table.columns, ...(group.field === "noRenewal" ? [] : (["renewal"] as SlackColumn[]))],
        members: true,
        rows: lapsed[group.field] as unknown as Record<string, string | null>[],
      }));
    }
    return [{ ...table, rows: result[table.field] as unknown as Record<string, string | null>[] }];
  });
}

type ConsolidationRow = AttributedOrderRow | CardNameOverrideRow | MemberSinceOverrideRow;

/**
 * The consolidations page's tables. `key` names each one's CSV download;
 * `columns` are the page's, and `csvColumns` the download's where they differ
 * (the page folds who set an override into one "Set by" cell).
 *
 * `imported` splits the card names in two: what a member or an admin set, and
 * what the one-time import carried over from the previous site
 * (`source = 'legacy_postgres'`). The old site set a card's name from the
 * member's first order or their Google or Apple profile, overwriting it at
 * every sign-in, so few of the names it left were chosen by anyone; listed
 * among the names set by hand they made that table hundreds of rows long,
 * where admins expect a handful.
 */
const CONSOLIDATION_TABLES: {
  key: string;
  field: keyof Consolidations;
  title: string;
  /** A line under the title, for a table whose rows need explaining. */
  about?: string;
  columns: readonly string[];
  headings: readonly string[];
  csvColumns?: readonly string[];
  imported?: boolean;
}[] = [
  {
    key: "attributed-orders",
    field: "attributed",
    title: "Orders attributed to another address",
    // The order's own name sits over its address (MemberLink), so its name
    // columns are left off the page; the download keeps them.
    columns: ["order_id", "order_email", "member_email", "created_on", "attributed_at", "attributed_by", "note"],
    headings: ["Order", "Order email", "Attributed to", "Started", "Changed", "Changed by", "Note"],
    csvColumns: ["order_id", "first_name", "last_name", "order_email", "member_email", "created_on", "attributed_at", "attributed_by", "note"],
  },
  {
    key: "card-names",
    field: "cardNames",
    title: "Card names set by hand",
    columns: ["member_email", "display_name", "order_name", "same_as_orders", "source", "set_at", "note", "order_id"],
    headings: ["Member", "Card shows", "Name from orders", "Compared", "Set by", "Set", "Note", "Latest order"],
    csvColumns: ["member_email", "display_name", "order_name", "same_as_orders", "source", "set_by", "set_at", "note", "order_id"],
    imported: false,
  },
  {
    key: "member-since",
    field: "memberSince",
    title: "\u201cMember since\u201d corrections",
    columns: ["member_email", "member_since", "order_member_since", "same_as_orders", "source", "set_at", "note", "order_id"],
    headings: ["Member", "Card shows", "Date from orders", "Compared", "Set by", "Set", "Note", "Earliest order"],
    csvColumns: ["member_email", "member_since", "order_member_since", "same_as_orders", "source", "set_by", "set_at", "note", "order_id"],
  },
  {
    key: "card-names-imported",
    field: "cardNames",
    title: "Card names carried over from the old site",
    about:
      "Not chosen by hand, mostly: the old site named a card after the member's first order or their Google or Apple profile, and replaced it at every sign-in. Members and admins can change any of them.",
    columns: ["member_email", "display_name", "order_name", "same_as_orders", "note", "order_id"],
    headings: ["Member", "Card shows", "Name from orders", "Compared", "Note", "Latest order"],
    csvColumns: ["member_email", "display_name", "order_name", "same_as_orders", "set_at", "note", "order_id"],
    imported: true,
  },
];

class BadRequest extends Error {}

/** A real calendar date in `YYYY-MM-DD` form, or null. */
interface ReportRequest {
  /** `YYYY-MM-DD` as typed, or empty for "right now". */
  asOfDate: string;
  /** The instant the report is evaluated at. */
  asOf: string;
  filters: ReportFilters;
  csv: boolean;
}

/**
 * A chosen date means the end of that day (UTC), so a membership bought that
 * afternoon counts; no date means this very moment.
 */
function parseReportRequest(query: Record<string, string>, now: Date): ReportRequest {
  const asOfDate = query.as_of ?? "";
  if (asOfDate && !parseIsoDate(asOfDate)) {
    throw new BadRequest("as_of must be a date in YYYY-MM-DD form");
  }
  return {
    asOfDate,
    asOf: asOfDate ? `${asOfDate}T23:59:59Z` : toIsoSeconds(now),
    filters: { channel: query.channel || undefined },
    csv: query.format === "csv",
  };
}

/** The current report URL, filters kept, plus `changes` (the format). */
function withParams(
  path: string,
  req: ReportRequest,
  changes: Record<string, string>,
): string {
  const params = new URLSearchParams();
  const current: Record<string, string> = {
    as_of: req.asOfDate,
    channel: req.filters.channel ?? "",
    ...changes,
  };
  for (const [key, value] of Object.entries(current)) {
    if (value) params.set(key, value);
  }
  return `${path}?${params.toString()}`;
}

/** What a report is "as of": the end of a chosen day (UTC, as the form says), or the moment it was drawn. */
const AsOf: FC<{ req: ReportRequest }> = ({ req }) =>
  req.asOfDate ? <>the end of {formatShortDate(req.asOfDate)} (UTC)</> : <When at={req.asOf} />;

const FilterForm: FC<{ path: string; req: ReportRequest; channels: string[] }> = ({
  path,
  req,
  channels,
}) => (
  <form method="get" action={path} style="display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin: 1rem 0">
    <label>
      As of date (UTC; blank = now)
      <br />
      <input type="date" name="as_of" value={req.asOfDate} />
    </label>
    <label>
      Channel
      <br />
      <select name="channel">
        <option value="">All</option>
        {channels.map((channel) => (
          <option value={channel} selected={channel === req.filters.channel}>
            {channel}
          </option>
        ))}
      </select>
    </label>
    <button type="submit">Apply</button>
  </form>
);

/**
 * Every report table: its CSV download first, where someone looking for it
 * finds it before scrolling past a few hundred rows, then the table itself,
 * sortable by any heading (src/admin/tableSort.ts) and narrowed by a box
 * that matches any column (src/admin/tableFilter.ts). Every row is sent;
 * sorting and filtering in the browser are only honest over the whole report.
 *
 * `children` is the table's `<tbody>` (and `<tfoot>`, if it has totals).
 */
/**
 * How tall a report table may get before it scrolls in place. These tables run
 * to thousands of rows -- the Slack cross-reference alone has four of them --
 * and a page that long buries whatever follows it.
 *
 * A scrolling box rather than paging: paging four independent tables means
 * either four sets of query parameters or client-side state, and the full data
 * is a CSV link away regardless. Sorting still sorts the whole table, which
 * paging would have broken.
 */
const TABLE_MAX_HEIGHT = "30rem";

/**
 * A heading that stays put while its table scrolls. The underline is a
 * box-shadow rather than the usual border because `border-collapse: collapse`
 * hands borders to the table, which scrolls away from the sticky cell.
 */
const STICKY_HEADING_STYLE = `${cellStyle}; position: sticky; top: 0; background: var(--bg); box-shadow: inset 0 -1px var(--rule)`;

const ReportTable: FC<
  PropsWithChildren<{ headings: readonly string[]; csvHref: string; csvLabel: string; empty?: string; rowCount: number }>
> = ({ headings, csvHref, csvLabel, empty, rowCount, children }) =>
  rowCount === 0 && empty ? (
    <p>{empty}</p>
  ) : (
    <div data-table-filter>
      <p>
        <a href={csvHref}>{csvLabel}</a>
      </p>
      <p class="table-filter" data-filter-control hidden>
        <label>
          Filter rows <input type="search" placeholder="Any column; every word must match" />
        </label>{" "}
        <span data-filter-count aria-live="polite"></span>
      </p>
      <div style={`overflow: auto; max-height: ${TABLE_MAX_HEIGHT}`}>
        <table data-sortable style="border-collapse: collapse; font-size: 0.9rem">
          <thead>
            <tr>
              {headings.map((heading) => (
                <th style={STICKY_HEADING_STYLE}>{heading}</th>
              ))}
            </tr>
          </thead>
          {children}
        </table>
      </div>
    </div>
  );

/** The name given on an order, as one line; empty when it gave none. */
function orderName(row: { first_name?: string | null; last_name?: string | null }): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

const OrdersTable: FC<{ rows: MembershipOrderRow[]; csvHref: string; total: number }> = ({ rows, csvHref, total }) => (
  <ReportTable
    headings={["Order", "Order email", "Member", "Started", "Expires", "Channel", "Status"]}
    csvHref={csvHref}
    csvLabel={`Download all ${total} as CSV`}
    rowCount={rows.length}
  >
    <tbody>
      {rows.map((row) => (
        <tr>
          <td style={cellStyle}>
            <OrderLink orderId={row.order_id} />
          </td>
          <td style={cellStyle}>
            {/* The order's own name over its address, leading to the order; the member it counts for beside it. */}
            <OrderLink orderId={row.order_id} email={row.order_email} name={orderName(row)} />
          </td>
          <td style={cellStyle}>
            {/* Always shown: left blank for the usual order, placed under the member's own address, it read as missing. */}
            <MemberLink email={row.member_email} />
          </td>
          <td style={cellStyle}>{row.created_on.slice(0, 10)}</td>
          <td style={cellStyle}>{row.expires_on.slice(0, 10)}</td>
          <td style={cellStyle}>{row.channel_name ?? row.source}</td>
          <td style={cellStyle}>{row.status ?? ""}</td>
        </tr>
      ))}
    </tbody>
  </ReportTable>
);

function csvResponse(name: string, req: ReportRequest, rows: MembershipOrderRow[]): Response {
  const stamp = req.asOf.slice(0, 10);
  return new Response(toCsv(ORDER_CSV_COLUMNS, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${stamp}.csv"`,
    },
  });
}

/** The consolidations columns holding a moment (epoch ms), shown with `When` and sorted by `sortKey`. */
const MOMENT_COLUMNS = new Set(["attributed_at", "set_at"]);

/**
 * Who set an override, in one cell: the member themselves, the admin who did
 * (or "an admin" once their account is gone), or the previous site, whose
 * rows the legacy import carried across.
 */
function overrideSetBy(row: CardNameOverrideRow | MemberSinceOverrideRow): string {
  if (row.source === "member") return "the member";
  if (row.source === "legacy_postgres") return "previous site";
  return row.set_by ?? "an admin";
}

/**
 * One consolidations cell: order ids link to their admin page, addresses to
 * their member, timestamps read as dates. `attributed_by` is an admin, not a
 * member, so it stays text. An override's comparison with its orders reads
 * as a word, so the table's filter box can find "same" -- an override that
 * has come to match its orders changes nothing and could be cleared.
 */
function consolidationCell(row: ConsolidationRow, column: string) {
  const value = row[column];
  if (column === "order_id") return value === null ? "" : <OrderLink orderId={String(value)} />;
  if (column === "order_email" && typeof value === "string") {
    // The order's own name, over the address it was placed under, leading to the order.
    if (row.order_id === null) return <MemberLink email={value} plain />;
    return (
      <OrderLink
        orderId={String(row.order_id)}
        email={value}
        name={orderName(row as { first_name?: string | null; last_name?: string | null })}
      />
    );
  }
  if (column === "member_email" && typeof value === "string") {
    // Named unless the row shows the card's name already ("Card shows").
    return <MemberLink email={value} plain={"display_name" in row} />;
  }
  if (column === "attributed_at" && value === null) return "legacy import";
  if (MOMENT_COLUMNS.has(column)) return <When at={Number(value)} />;
  if (column === "source") return overrideSetBy(row as CardNameOverrideRow | MemberSinceOverrideRow);
  if (column === "same_as_orders") return value === null ? "no card" : value ? "same" : "differs";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return value === null ? "" : String(value);
}

const reports = new Hono<AuthEnv & { Bindings: Env }>();

reports.use("*", requireAdmin);
reports.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
reports.onError((err, c) => {
  if (err instanceof BadRequest) {
    return c.text(`Bad Request: ${err.message}`, 400);
  }
  throw err;
});

reports.get("/", async (c) => {
  // The two reports of things wanting action are listed only when they have
  // something in them, as in the nav (src/admin/nav.tsx); both show if the
  // count fails, since that is not the same as nothing to look at.
  const counts = await attentionCounts(c.env.DB, toIsoSeconds(new Date())).catch(() => null);
  const worthALook = (key: keyof AttentionCounts) => counts === null || counts[key] > 0;
  return c.html(
    <AdminPage title="Membership reports">
      <ul>
        <li>
          <a href="/admin/reports/memberships">Active and expired memberships</a>: every active membership order,
          and each lapsed member's most recent one, today or on any past date.
        </li>
        <li>
          <a href="/admin/reports/over-time">Membership over time</a>: active members and membership orders,
          any years side by side, and orders by product each year.
        </li>
        <li>
          <a href="/admin/reports/renewals">Renewals</a>: what MiniBC says about members' automatic renewals --
          membership cards that ran out with a renewal still on, renewals due after the membership card runs out, and those
          coming up.
        </li>
        <li>
          <a href="/admin/reports/consolidations">Consolidations</a>: memberships attributed to another address,
          card names and "member since" dates set by hand, and the card names the old site carried over.
        </li>
        <li>
          <a href="/admin/reports/slack">Slack cross-reference</a>: current and lapsed members with and without
          Slack accounts, and Slack users who never bought a membership.
        </li>
        {worthALook("extraMemberships") && (
          <li>
            <a href="/admin/reports/extra-memberships">More than one membership</a>: orders that carried more than
            one membership. Only one was recorded, so somebody paid for a card that does not exist.
          </li>
        )}
        {worthALook("missing") && (
          <li>
            <a href="/admin/reports/missing">Missing from BigCommerce</a>: orders the store no longer returns. They
            still count; this is the list to decide about.
          </li>
        )}
      </ul>
    </AdminPage>,
  );
});

const MEMBERSHIPS_PATH = "/admin/reports/memberships";

/** The page's two tables, each its own CSV (`?format=csv&table=`). */
const MEMBERSHIP_TABLES = ["active", "expired"] as const;
type MembershipTable = (typeof MEMBERSHIP_TABLES)[number];

/**
 * Active and expired memberships, on one page: the same date and channel
 * answer both, and an admin asking one question usually wants the other's
 * count beside it. They were separate pages, and the old addresses redirect
 * here (below), so bookmarks and CSV links keep working.
 */
reports.get("/memberships", async (c) => {
  const req = parseReportRequest(c.req.query(), new Date());
  if (req.csv) {
    const table = c.req.query("table");
    if (table === "active") return csvResponse("active-memberships", req, (await activeMemberships(c.env.DB, req.asOf, req.filters)).rows);
    if (table === "expired") return csvResponse("expired-memberships", req, (await expiredMemberships(c.env.DB, req.asOf, req.filters)).rows);
    throw new BadRequest(`table must be one of ${MEMBERSHIP_TABLES.join(", ")}`);
  }
  const [active, expired, channels] = await Promise.all([
    activeMemberships(c.env.DB, req.asOf, req.filters),
    expiredMemberships(c.env.DB, req.asOf, req.filters),
    listChannels(c.env.DB),
  ]);
  const csvHref = (table: MembershipTable) => withParams(MEMBERSHIPS_PATH, req, { format: "csv", table });
  return c.html(
    <AdminPage title="Active and expired memberships">
      <p>
        Unpaid, cancelled, refunded, and test orders are left out of both. <a href="#active">Active</a>:{" "}
        <strong>{active.totalMembers}</strong> members holding <strong>{active.totalOrders}</strong> orders.{" "}
        <a href="#expired">Expired</a>: <strong>{expired.total}</strong> lapsed members. As of <AsOf req={req} />.
      </p>
      <FilterForm path={MEMBERSHIPS_PATH} req={req} channels={channels} />
      <h2 id="active">Active</h2>
      <p>Membership orders active at the chosen moment.</p>
      <OrdersTable rows={active.rows} csvHref={csvHref("active")} total={active.totalOrders} />
      <h2 id="expired">Expired</h2>
      <p>
        Members whose most recent membership had expired at the chosen moment, shown by that most recent order. A
        member who renewed under a different email address is not listed.
      </p>
      <OrdersTable rows={expired.rows} csvHref={csvHref("expired")} total={expired.total} />
    </AdminPage>,
  );
});

/**
 * The two pages the one above replaced. A CSV download from either still
 * downloads the same table; anything else lands on that table's section.
 */
for (const table of MEMBERSHIP_TABLES) {
  reports.get(`/${table}`, (c) => {
    const params = new URLSearchParams(c.req.query());
    const csv = params.get("format") === "csv";
    if (csv) params.set("table", table);
    const query = params.toString();
    return c.redirect(`${MEMBERSHIPS_PATH}${query ? `?${query}` : ""}${csv ? "" : `#${table}`}`, 301);
  });
}

const OVER_TIME_PATH = "/admin/reports/over-time";

/** How many years the page compares unless asked for others. */
const DEFAULT_YEARS_SHOWN = 3;

const YEAR_MS = 365 * 86_400_000;

/** Parses the repeated `year` parameter; none means the latest few. */
function chosenYears(raw: string[], available: number[]): number[] {
  const years = raw.filter((value) => value !== "").map(Number);
  for (const year of years) {
    if (!available.includes(year)) {
      throw new BadRequest(`year must be one of ${available[0]}-${available[available.length - 1]}`);
    }
  }
  const chosen = [...new Set(years)].sort((a, b) => a - b);
  return chosen.length > 0 ? chosen : available.slice(-DEFAULT_YEARS_SHOWN);
}

/** "2026-03" for March 2026 (`month` from 0). */
function yearMonth(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** A product's name in "Orders by product": its store name where known. */
export function productLabel(product: string): string {
  if (product === "squarespace") return "Squarespace (before BigCommerce)";
  if (product === "") return "No SKU recorded";
  const name = MEMBERSHIP_PRODUCTS.get(product);
  return name ? `${name} (${product})` : product;
}

/** Squarespace first, then the store's products in their listed order, then anything else. */
function productOrder(products: Iterable<string>): string[] {
  const known = [...MEMBERSHIP_PRODUCTS.keys()];
  const rank = (product: string) =>
    product === "squarespace" ? -1 : known.includes(product) ? known.indexOf(product) : product === "" ? known.length + 1 : known.length;
  return [...new Set(products)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Membership over time: how many people held an active membership each day
 * (src/admin/membersOverTime.ts), and how many membership orders came in
 * each month -- the two questions a planning conversation asks about a year,
 * answered for the same years side by side. Each is one line per year over
 * the same January-to-December axis, so a season sits over the same season
 * in another year, or one line across every year. The tables beneath carry
 * the figures: members on the first of each month, orders in each month.
 *
 * Replaces the "orders by month" report (this year against last), which
 * `/admin/reports/orders` now redirects here with the same two years.
 */
reports.get("/over-time", async (c) => {
  const today = toIsoSeconds(new Date()).slice(0, 10);
  const [orders, perDay, byProduct] = await Promise.all([
    countedMembershipOrders(c.env.DB),
    ordersByDay(c.env.DB),
    ordersByYearAndProduct(c.env.DB),
  ]);
  const firstDay = [orders.reduce((min, order) => (order.created_on < min ? order.created_on : min), today), perDay[0]?.day ?? today]
    .sort()[0]
    .slice(0, 10);
  const members = activeMembersByDay(orders, firstDay, today);
  const membersOn = new Map(members.map((point) => [point.day, point.members]));
  const ordersIn = new Map<string, number>();
  for (const { day, orders: count } of perDay) ordersIn.set(day.slice(0, 7), (ordersIn.get(day.slice(0, 7)) ?? 0) + count);

  const table = c.req.query("table");
  if (c.req.query("format") === "csv") {
    const stamp = `${today}.csv"`;
    if (table === "members") {
      return new Response(toCsv(["date", "active_members"], members.map((point) => ({ date: point.day, active_members: point.members }))), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="active-members-by-day-${stamp}` },
      });
    }
    if (table === "orders") {
      const rows = [...ordersIn].map(([month, count]) => ({ month, orders: count }));
      return new Response(toCsv(["month", "orders"], rows), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="membership-orders-by-month-${stamp}` },
      });
    }
    if (table === "products") {
      const rows = byProduct.map((row) => ({ year: row.year, sku: row.product, product: productLabel(row.product), orders: row.orders }));
      return new Response(toCsv(["year", "sku", "product", "orders"], rows), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="membership-orders-by-product-${stamp}` },
      });
    }
    throw new BadRequest("table must be one of members, orders, products");
  }

  const thisYear = Number(today.slice(0, 4));
  const firstYear = Number(firstDay.slice(0, 4));
  const available = Array.from({ length: thisYear - firstYear + 1 }, (_, i) => firstYear + i);
  const timeline = c.req.query("view") === "timeline";
  const years = timeline ? available : chosenYears(c.req.queries("year") ?? [], available);
  const currentMonth = Number(today.slice(5, 7)) - 1;
  const monthsOf = (year: number) => (year === thisYear ? currentMonth + 1 : 12);

  // Year by year, each point placed by how far through its year it falls;
  // every year as one line, by how far through the whole history.
  const yearStart = (year: number) => Date.UTC(year, 0, 1);
  const span = Date.parse(today) - Date.parse(firstDay);
  const throughHistory = (ms: number) => (span > 0 ? (ms - Date.parse(firstDay)) / span : 0);
  const allYears = `${firstYear}–${thisYear}`;
  const memberLines: LineSeries[] = timeline
    ? [{ label: allYears, points: members.map((point) => ({ x: throughHistory(Date.parse(point.day)), value: point.members })) }]
    : years.map((year) => ({
        label: String(year),
        points: members
          .filter((point) => point.day.startsWith(`${year}-`))
          .map((point) => ({ x: Math.min((Date.parse(point.day) - yearStart(year)) / YEAR_MS, 1), value: point.members })),
      }));
  // Orders are counts per month, so they are bars, grouped by month with one
  // per year, so a month can be set against the same month of other years.
  // That holds in the timeline too, where the members chart is one line: its
  // years are every year. A month still to come has no bar.
  const midMonth = (year: number, month: number) => Date.UTC(year, month, 15);
  const orderGroups: BarGroup[] = MONTH_NAMES.map((name) => ({ label: name.slice(0, 3), title: name.slice(0, 3) }));
  const orderBars: BarSeries[] = years.map((year) => ({
    label: String(year),
    values: MONTH_NAMES.map((_, month) => (month < monthsOf(year) ? (ordersIn.get(yearMonth(year, month)) ?? 0) : null)),
  }));
  const xLabels = timeline
    ? available.map((year) => ({ x: throughHistory(yearStart(year)), text: String(year) })).filter((label) => label.x >= 0)
    : MONTH_NAMES.map((name, month) => ({ x: (midMonth(2025, month) - yearStart(2025)) / YEAR_MS, text: name.slice(0, 3) }));

  const lastYearToday = `${thisYear - 1}${today.slice(4)}`;
  const ordersBetween = (from: string, to: string) =>
    perDay.filter((point) => point.day >= from && point.day <= to).reduce((sum, point) => sum + point.orders, 0);
  const ordersThisYear = ordersBetween(`${thisYear}-01-01`, today);
  const ordersByNowLastYear = ordersBetween(`${thisYear - 1}-01-01`, lastYearToday);
  const count = (value: number) => value.toLocaleString("en-US");
  const which = timeline ? `from ${firstDay} to ${today}` : `in ${years.join(", ")}, one line per year`;
  const products = productOrder(byProduct.map((row) => row.product));
  const productOrders = new Map(byProduct.map((row) => [`${row.year}|${row.product}`, row.orders]));
  const ordersFor = (year: number | string, product: string) => productOrders.get(`${year}|${product}`) ?? 0;

  return c.html(
    <AdminPage title="Membership over time">
      <p>
        <strong>{count(membersOn.get(today) ?? 0)}</strong> active members today, against{" "}
        <strong>{count(membersOn.get(lastYearToday) ?? 0)}</strong> on this day last year.{" "}
        <strong>{count(ordersThisYear)}</strong> membership orders so far this year, against{" "}
        <strong>{count(ordersByNowLastYear)}</strong> by this day last year.
      </p>
      <form method="get" action={OVER_TIME_PATH} style="display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin: 1rem 0">
        <fieldset style="border: 0; padding: 0; margin: 0">
          <legend>Years to compare</legend>
          {available.map((year) => (
            <label style="margin-right: 0.6rem">
              <input type="checkbox" name="year" value={String(year)} checked={!timeline && years.includes(year)} /> {year}
            </label>
          ))}
        </fieldset>
        <button type="submit">Compare</button>
        {timeline ? (
          <a href={OVER_TIME_PATH}>Compare years instead</a>
        ) : (
          <span>
            or <a href={`${OVER_TIME_PATH}?view=timeline`}>see every year as one line</a>
          </span>
        )}
      </form>

      <h2>Active members</h2>
      <p class="muted">
        Each day counted as the <a href="/admin/reports/memberships#active">Active memberships</a> report counts that day.
      </p>
      <LineChart
        series={memberLines}
        xLabels={xLabels}
        description={`Active members each day ${which}; the table below has the count on the first of each month.`}
      />
      <ReportTable
        headings={["On the 1st of", ...years.map(String)]}
        csvHref={`${OVER_TIME_PATH}?table=members&format=csv`}
        csvLabel="Download every day as CSV"
        rowCount={12}
      >
        <tbody>
          {MONTH_NAMES.map((name, month) => (
            <tr>
              <td style={cellStyle} data-sort={String(month + 1).padStart(2, "0")}>
                {name}
              </td>
              {years.map((year) => {
                const value = membersOn.get(`${yearMonth(year, month)}-01`);
                return <td style={cellStyle}>{value === undefined ? "" : count(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </ReportTable>

      <h2>Membership orders</h2>
      <p class="muted">Orders that count towards a membership, in the month they were placed (UTC).</p>
      <BarChart
        groups={orderGroups}
        series={orderBars}
        unit={["order", "orders"]}
        description={`Membership orders per month in ${years.join(", ")}, one bar per year in each month; the table below has each month's figure.`}
      />
      <ReportTable
        headings={["Month (UTC)", ...years.map(String)]}
        csvHref={`${OVER_TIME_PATH}?table=orders&format=csv`}
        csvLabel="Download every month as CSV"
        rowCount={12}
      >
        <tbody>
          {MONTH_NAMES.map((name, month) => (
            <tr>
              <td style={cellStyle} data-sort={String(month + 1).padStart(2, "0")}>
                {name}
              </td>
              {years.map((year) => (
                <td style={cellStyle}>{month < monthsOf(year) ? count(ordersIn.get(yearMonth(year, month)) ?? 0) : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th style={cellStyle}>Total</th>
            {years.map((year) => (
              <th style={cellStyle}>
                {count(Array.from({ length: 12 }, (_, month) => ordersIn.get(yearMonth(year, month)) ?? 0).reduce((a, b) => a + b, 0))}
              </th>
            ))}
          </tr>
        </tfoot>
      </ReportTable>

      <h2>Orders by product</h2>
      <p class="muted">
        The same orders, each year, by which membership product was bought. Every year is shown, whichever are
        compared above.
      </p>
      <ReportTable
        headings={["Year (UTC)", ...products.map(productLabel), "Total"]}
        csvHref={`${OVER_TIME_PATH}?table=products&format=csv`}
        csvLabel="Download as CSV"
        empty="No membership orders yet."
        rowCount={byProduct.length}
      >
        <tbody>
          {available.map((year) => (
            <tr>
              <td style={cellStyle}>{year}</td>
              {products.map((product) => (
                <td style={cellStyle}>{count(ordersFor(year, product))}</td>
              ))}
              <th style={cellStyle}>{count(products.reduce((sum, product) => sum + ordersFor(year, product), 0))}</th>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th style={cellStyle}>Total</th>
            {products.map((product) => (
              <th style={cellStyle}>{count(available.reduce((sum, year) => sum + ordersFor(year, product), 0))}</th>
            ))}
            <th style={cellStyle}>{count(byProduct.reduce((sum, row) => sum + row.orders, 0))}</th>
          </tr>
        </tfoot>
      </ReportTable>
    </AdminPage>,
  );
});

/**
 * Where "orders by month" used to be: the same year against the year before,
 * on the page that replaced it. A bad year is refused as it was, rather than
 * quietly showing something else.
 */
reports.get("/orders", (c) => {
  const thisYear = new Date().getUTCFullYear();
  const raw = c.req.query("year");
  const year = raw === undefined || raw === "" ? thisYear : Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > thisYear + 1) {
    throw new BadRequest("year must be a four-digit year");
  }
  return c.redirect(`${OVER_TIME_PATH}?year=${year - 1}&year=${year}`, 301);
});

/**
 * Current snapshot only: Slack accounts have no history, so a past date would
 * compare old memberships against today's workspace.
 */
reports.get("/slack", async (c) => {
  const asOf = toIsoSeconds(new Date());
  const format = c.req.query("format");
  // Split only where MiniBC is read and has been: with no read yet, every
  // lapsed member would wrongly show as never having renewed automatically.
  const [result, renewals] = await Promise.all([
    slackCrossReference(c.env.DB, asOf),
    c.env.MINIBC_API_KEY
      ? lastRenewalsRead(c.env).then((read) => (read === null ? null : allRenewals(c.env)))
      : Promise.resolve(null),
  ]);
  const lapsed = renewals ? splitLapsedByRenewal(result.lapsedInSlack, renewals, asOf.slice(0, 10)) : null;
  const shown = slackTables(result, lapsed);
  // Every table shown, plus the whole lapsed list, whose download older links ask for.
  const downloadable = [...shown, ...slackTables(result, null).filter((table) => !shown.some((each) => each.key === table.key))];
  const csvTable = format === "csv" ? downloadable.find((t) => t.key === c.req.query("table")) : undefined;
  if (format === "csv" && !csvTable) {
    throw new BadRequest(`table must be one of ${downloadable.map((t) => t.key).join(", ")}`);
  }
  if (csvTable) {
    return new Response(toCsv(csvTable.columns, csvTable.rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="slack-${csvTable.key}-${asOf.slice(0, 10)}.csv"`,
      },
    });
  }
  return c.html(
    <AdminPage title="Slack cross-reference">
      <p>
        Members matched to Slack accounts by email, as of <When at={asOf} />. Unpaid, cancelled, refunded, and test orders are left out;
        so are deactivated Slack accounts, bots, and accounts without an email. A member who joined Slack under a
        different address shows as not in Slack.
      </p>
      <p>
        {result.slackSyncedAt === null ? (
          "The Slack sync has not run yet, so nobody shows as in Slack."
        ) : (
          <>
            Slack accounts last synced <When at={result.slackSyncedAt} ago />.
          </>
        )}
      </p>
      {shown.map((table) => {
        const rows = table.rows;
        // On the page a member is one cell, their card's name over their
        // address (MemberLink), so the order's billing-name columns go; the
        // download keeps them. Slack's own names stay: a separate record.
        const columns = table.members ? table.columns.filter((column) => column !== "first_name" && column !== "last_name") : table.columns;
        return (
          <section>
            <h2>
              {table.title} ({rows.length})
            </h2>
            <ReportTable
              headings={columns.map((column) => (column === "email" && table.members ? "Member" : SLACK_COLUMN_HEADINGS[column]))}
              csvHref={`/admin/reports/slack?table=${table.key}&format=csv`}
              csvLabel={`Download all ${rows.length} as CSV`}
              rowCount={rows.length}
            >
              <tbody>
                {rows.map((row) => (
                  <tr>
                    {columns.map((column) => {
                      const value = row[column];
                      if (column === "email" && table.members && value) {
                        return (
                          <td style={cellStyle}>
                            <MemberLink email={value} />
                          </td>
                        );
                      }
                      // Dates shown as days; the CSV keeps the full timestamp.
                      return <td style={cellStyle}>{value?.slice(0, column === "expires_on" ? 10 : undefined)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </section>
        );
      })}
    </AdminPage>,
  );
});

/** One section of the Renewals report, and which subscriptions it lists. */
interface RenewalSection {
  key: string;
  title: string;
  about: string;
  pick: (row: RenewalRow, state: RenewalState, today: string, soon: string) => boolean;
}

const RENEWAL_SECTIONS: RenewalSection[] = [
  {
    key: "overdue",
    title: "Membership card ran out, automatic renewal still on",
    about: "The renewal payment failed, or is still to be tried: the member has no current membership card until it goes through.",
    pick: (row, state) => row.member_email !== null && state.kind === "overdue",
  },
  {
    key: "late",
    title: "Renews after the membership card runs out",
    about: "MiniBC's next payment is more than a day after the membership card's last day, most often after an earlier failed payment, so the membership lapses in between.",
    pick: (row, state) => row.member_email !== null && state.kind === "renews-late",
  },
  {
    key: "soon",
    title: "Renewing in the next 30 days",
    about: "On time: MiniBC's next payment is on or just after the membership card's last day.",
    pick: (row, state, _today, soon) => row.member_email !== null && state.kind === "renews" && state.on <= soon,
  },
  {
    key: "stopped",
    title: "Cancelled or paused, membership card still current",
    about: "These won't renew by themselves; the member would need to buy again.",
    pick: (row, state, today) =>
      row.member_email !== null && (state.kind === "cancelled" || state.kind === "paused") && (row.expiration_date ?? "") >= today,
  },
  {
    key: "unmatched",
    title: "Not matched to a member",
    about:
      "No membership order held here started or carries the subscription, and its store customer has no membership order of their own. Usually one bought before these records begin, or under an order since re-attributed. Its order's page here can read that order in from BigCommerce, which matches it if the order carries a membership; its store customer's page in BigCommerce names who pays.",
    pick: (row) => row.member_email === null,
  },
];

const RENEWAL_COLUMNS = [
  "subscription_id", "member_email", "member_id", "name", "good_through", "status", "next_payment_on", "paused_on", "cancelled_on", "signup_on", "order_id", "what_next", "sku", "store_customer_id",
] as const;

/** What a subscription is for, from its SKU, saying so when it isn't a membership product this site counts. */
function subscriptionProduct(sku: string): string {
  return MEMBERSHIP_PRODUCTS.has(sku) ? productLabel(sku) : `${sku} (not a membership product here)`;
}

reports.get("/renewals", async (c) => {
  const today = toIsoSeconds(new Date()).slice(0, 10);
  const soon = toIsoSeconds(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10);
  const format = c.req.query("format");
  const csvSection = format === "csv" ? RENEWAL_SECTIONS.find((section) => section.key === c.req.query("section")) : undefined;
  if (format === "csv" && !csvSection) {
    throw new BadRequest(`section must be one of ${RENEWAL_SECTIONS.map((section) => section.key).join(", ")}`);
  }
  const [rows, lastRead] = await Promise.all([allRenewals(c.env), lastRenewalsRead(c.env)]);
  const withState = rows.map((row) => ({ row, state: renewalState(row, row.member_email ? row.expiration_date : null, today) }));
  const sectionRows = (section: RenewalSection) => withState.filter(({ row, state }) => section.pick(row, state, today, soon));

  if (csvSection) {
    const csvRows = sectionRows(csvSection).map(({ row, state }) => ({
      subscription_id: String(row.subscription_id),
      member_email: row.member_email,
      member_id: row.member_id,
      name: row.display_name ?? ([row.first_name, row.last_name].filter(Boolean).join(" ") || null),
      good_through: row.expiration_date,
      status: row.status,
      next_payment_on: row.next_payment_on,
      paused_on: row.paused_on,
      cancelled_on: row.cancelled_on,
      signup_on: row.signup_on,
      order_id: row.order_id === null ? null : String(row.order_id),
      what_next: row.member_email ? renewalText(state) : null,
      sku: row.sku,
      store_customer_id: row.store_customer_id,
    }));
    return new Response(toCsv([...RENEWAL_COLUMNS], csvRows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="renewals-${csvSection.key}-${today}.csv"`,
      },
    });
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return c.html(
    <AdminPage title="Renewals">
      <p>
        What MiniBC, which runs the store's automatic renewals, says about each member's. It changes no membership card: a renewal
        counts once its BigCommerce order is paid, like any other. Subscriptions are matched to members through their
        orders, never an address.
      </p>
      <p>
        {c.env.MINIBC_API_KEY ? (
          lastRead === null ? (
            "MiniBC has not been read here yet; it is read twice a day."
          ) : (
            <>
              {rows.length} subscriptions as of <When at={lastRead} ago />:{" "}
              {[...counts].map(([status, n]) => `${n} ${status === "inactive" ? "cancelled" : status}`).join(", ")}. Read twice a
              day.
            </>
          )
        ) : (
          "MiniBC isn't read in this environment (MINIBC_API_KEY unset)."
        )}
      </p>
      {RENEWAL_SECTIONS.map((section) => {
        const listed = sectionRows(section);
        return (
          <section>
            <h2>
              {section.title} ({listed.length})
            </h2>
            <p class="muted">{section.about}</p>
            <ReportTable
              headings={section.key === "unmatched" ? ["Subscription", "For", "MiniBC", "Next payment", "Signed up", "Started by order", "Store customer"] : ["Member", "Good through", "What next", "Subscription"]}
              csvHref={`/admin/reports/renewals?section=${section.key}&format=csv`}
              csvLabel={`Download all ${listed.length} as CSV`}
              empty="None."
              rowCount={listed.length}
            >
              <tbody>
                {listed.map(({ row, state }) =>
                  section.key === "unmatched" ? (
                    <tr>
                      <td style={cellStyle}>{row.subscription_id}</td>
                      <td style={cellStyle}>{subscriptionProduct(row.sku)}</td>
                      <td style={cellStyle}>{row.status === "inactive" ? "cancelled" : row.status}</td>
                      <td style={cellStyle}>{row.next_payment_on ?? ""}</td>
                      <td style={cellStyle}>{row.signup_on ?? ""}</td>
                      <td style={cellStyle}>
                        {row.order_id === null ? (
                          ""
                        ) : (
                          <>
                            <OrderLink orderId={String(row.order_id)} /> <StoreOrderLink orderId={String(row.order_id)}>store</StoreOrderLink>
                          </>
                        )}
                      </td>
                      <td style={cellStyle}>
                        {row.store_customer_id ? <StoreCustomerLink customerId={row.store_customer_id} /> : "a guest checkout"}
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td style={cellStyle}>
                        <MemberLink email={row.member_email!} />
                      </td>
                      <td style={cellStyle}>{row.expiration_date ?? "no counted orders"}</td>
                      <td style={`${cellStyle}; white-space: normal; min-width: 14rem; max-width: 32rem`}>{renewalText(state)}</td>
                      <td style={cellStyle}>{row.subscription_id}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </ReportTable>
          </section>
        );
      })}
    </AdminPage>,
  );
});

/**
 * The legacy "Membership Consolidations" page, grown to cover every choice
 * that makes a card differ from its orders: attributions (by an admin, #70,
 * or by the legacy import, which knows each legacy user's current address),
 * card names set by hand, and corrected "member since" dates. It once also
 * listed billing names found under several addresses; nothing followed from
 * that list, so it went. Each order links to its admin page, each address to
 * its member.
 */
reports.get("/consolidations", async (c) => {
  const format = c.req.query("format");
  const csvTable = format === "csv" ? CONSOLIDATION_TABLES.find((table) => table.key === c.req.query("table")) : undefined;
  if (format === "csv" && !csvTable) {
    throw new BadRequest(`table must be one of ${CONSOLIDATION_TABLES.map((table) => table.key).join(", ")}`);
  }
  const result = await consolidations(c.env.DB);
  const rowsFor = (table: (typeof CONSOLIDATION_TABLES)[number]): ConsolidationRow[] =>
    (result[table.field] as ConsolidationRow[]).filter(
      (row) => table.imported === undefined || (row.source === "legacy_postgres") === table.imported,
    );
  if (csvTable) {
    return new Response(toCsv([...(csvTable.csvColumns ?? csvTable.columns)], rowsFor(csvTable)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="consolidations-${csvTable.key}-${toIsoSeconds(new Date()).slice(0, 10)}.csv"`,
      },
    });
  }
  return c.html(
    <AdminPage title="Consolidations">
      <p>
        Where a card says something other than its orders would: a membership attributed to another address, a name
        set by hand, or a corrected &ldquo;member since&rdquo;, then the card names the old site carried over. Names and dates
        sit beside what the orders alone would give; one marked &ldquo;same&rdquo; has come to match them and changes
        nothing. Follow an order to change who it is attributed to, or a member to change their card.
      </p>
      {CONSOLIDATION_TABLES.map((table) => {
        const rows = rowsFor(table);
        return (
          <section>
            <h2>
              {table.title} ({rows.length})
            </h2>
            {table.about && <p class="muted">{table.about}</p>}
            <ReportTable
              headings={table.headings}
              csvHref={`/admin/reports/consolidations?table=${table.key}&format=csv`}
              csvLabel={`Download all ${rows.length} as CSV`}
              rowCount={rows.length}
            >
              <tbody>
                {rows.map((row) => (
                  <tr>
                    {table.columns.map((column) => (
                      <td
                        style={cellStyle}
                        data-sort={MOMENT_COLUMNS.has(column) && row[column] !== null ? sortKey(Number(row[column])) : undefined}
                      >
                        {consolidationCell(row, column)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </section>
        );
      })}
    </AdminPage>,
  );
});

const MISSING_ORDER_COLUMNS = [
  "order_id",
  "member_email",
  "first_name",
  "last_name",
  "status",
  "created_on",
  "expires_on",
  "missing_since",
] as const;

/**
 * Orders BigCommerce has stopped returning (#105).
 *
 * Read this page as a question, not a defect list. Nothing here has been
 * taken away from anyone: each order still counts towards its member's
 * membership, exactly as it did before it went missing. The flag is here
 * because deciding to revoke somebody's membership is a judgement, and a
 * 404 from an API is not a good enough reason to make it automatically.
 */
reports.get("/missing", async (c) => {
  const rows = await missingOrders(c.env.DB);
  if (c.req.query("format") === "csv") {
    return new Response(toCsv([...MISSING_ORDER_COLUMNS], rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="missing-orders-${toIsoSeconds(new Date()).slice(0, 10)}.csv"`,
      },
    });
  }
  return c.html(
    <AdminPage title="Missing from BigCommerce">
      <p>
        Orders the store no longer returns, oldest sighting first. <strong>They still count towards membership</strong>
        {" "}
        -- nobody's membership has been revoked. An order can vanish because it was deleted or archived in
        BigCommerce, and it can also vanish because the store had a bad day, so the flag clears itself if a later
        sync finds the order again.
      </p>
      <ReportTable
        headings={["Order", "Member", "Name", "Status", "Membership", "First missed"]}
        csvHref="/admin/reports/missing?format=csv"
        csvLabel={`Download all ${rows.length} as CSV`}
        empty="No orders are missing."
        rowCount={rows.length}
      >
        <tbody>
          {rows.map((row: MissingOrderRow) => (
            <tr>
              <td style={cellStyle}>
                <OrderLink orderId={row.order_id} />
              </td>
              <td style={cellStyle}>
                <MemberLink email={row.member_email} plain />
              </td>
              <td style={cellStyle}>{`${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()}</td>
              <td style={cellStyle}>{row.status ?? ""}</td>
              <td style={cellStyle}>
                {row.counts ? `counts, to ${row.expires_on.slice(0, 10)}` : "doesn't count"}
              </td>
              <td style={cellStyle}>{new Date(row.missing_since).toISOString().slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </ReportTable>
    </AdminPage>,
  );
});

const EXTRA_MEMBERSHIP_COLUMNS = [
  "order_id",
  "member_email",
  "first_name",
  "last_name",
  "status",
  "created_on",
  "expires_on",
  "membership_units",
] as const;

/**
 * Orders carrying more than one membership (#188).
 *
 * Read this the same way as the missing-orders page: a question rather than
 * a defect list. Nothing has been taken from anyone -- the order still
 * confers the membership it is recorded as. What it shows is the opposite
 * problem, somebody who paid and got nothing, which no amount of syncing
 * will fix by itself because there is nowhere for a second membership to go.
 */
reports.get("/extra-memberships", async (c) => {
  const asOf = toIsoSeconds(new Date());
  const rows = await ordersWithExtraMemberships(c.env.DB, asOf);
  if (c.req.query("format") === "csv") {
    return new Response(toCsv([...EXTRA_MEMBERSHIP_COLUMNS], rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="extra-memberships-${toIsoSeconds(new Date()).slice(0, 10)}.csv"`,
      },
    });
  }
  const setAside = await extraMembershipOrdersSetAside(c.env.DB, asOf);
  return c.html(
    <AdminPage title="More than one membership">
      <p>
        The storefront is set up so an order never carries more than one membership, and this system depends on it:
        an order holds one membership and can be attributed to one person. Anything listed here broke that, which
        means <strong>somebody paid for a membership that no card exists for</strong>.
      </p>
      <p>
        The order still counts for the one membership it is recorded as -- nothing has been revoked. Putting the
        rest right is a person&#39;s job: refund the extra, or place the membership under the right address. An order
        corrected in BigCommerce drops off this list on the next sync.
      </p>
      {setAside > 0 && (
        <p class="muted">
          Only orders that still count and have not expired are listed. {setAside}{" "}
          {setAside === 1 ? "other order carries" : "other orders carry"} more than one membership but{" "}
          {setAside === 1 ? "has" : "have"} been refunded, cancelled or run out, so nobody is owed a card for{" "}
          {setAside === 1 ? "it" : "them"} any more.
        </p>
      )}
      <ReportTable
        headings={["Order", "Member", "Name", "Status", "Membership", "Memberships on order"]}
        csvHref="/admin/reports/extra-memberships?format=csv"
        csvLabel={`Download all ${rows.length} as CSV`}
        empty="No order carries more than one membership."
        rowCount={rows.length}
      >
        <tbody>
          {rows.map((row: ExtraMembershipOrderRow) => (
            <tr>
              <td style={cellStyle}>
                <OrderLink orderId={row.order_id} />
              </td>
              <td style={cellStyle}>
                <MemberLink email={row.member_email} plain />
              </td>
              <td style={cellStyle}>{`${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()}</td>
              <td style={cellStyle}>{row.status ?? ""}</td>
              <td style={cellStyle}>
                {row.counts ? `counts, to ${row.expires_on.slice(0, 10)}` : "doesn't count"}
              </td>
              <td style={cellStyle}>{row.membership_units}</td>
            </tr>
          ))}
        </tbody>
      </ReportTable>
    </AdminPage>,
  );
});

export default reports;
