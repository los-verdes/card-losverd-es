/**
 * Admin-only membership reports, replacing the legacy Google Data Studio
 * report that read Cloud SQL directly (los-verdes/card-losverd-es#53).
 * Server-rendered tables over `membership_orders`, each downloadable as CSV.
 *
 * Every response is `no-store`: these pages list members' names and emails.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { toIsoSeconds } from "../bigcommerce/orders";
import { parseIsoDate } from "../lib/dateFormat";
import type { Env } from "../index";
import { toCsv } from "../lib/csv";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";
import { orderPath } from "./orders";
import {
  activeMemberships,
  consolidations,
  expiredMemberships,
  listChannels,
  missingOrders,
  ordersByMonth,
  slackCrossReference,
  type AttributedOrderRow,
  type DuplicateNameRow,
  type MembershipOrderRow,
  type MissingOrderRow,
  type ReportFilters,
  type SlackCrossReference,
} from "./reportQueries";

export const PAGE_SIZE = 100;

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
};

type SlackColumn = keyof typeof SLACK_COLUMN_HEADINGS;

const MEMBER_COLUMNS: SlackColumn[] = ["email", "first_name", "last_name", "expires_on"];
const SLACK_COLUMNS: SlackColumn[] = ["slack_id", "slack_name"];

/** The Slack page's four tables; `key` names each one's CSV download. */
const SLACK_TABLES: {
  key: string;
  field: Exclude<keyof SlackCrossReference, "slackSyncedAt">;
  title: string;
  columns: SlackColumn[];
}[] = [
  { key: "current-in-slack", field: "currentInSlack", title: "Current members in Slack", columns: [...MEMBER_COLUMNS, ...SLACK_COLUMNS] },
  { key: "current-not-in-slack", field: "currentNotInSlack", title: "Current members not in Slack", columns: MEMBER_COLUMNS },
  { key: "lapsed-in-slack", field: "lapsedInSlack", title: "Lapsed members in Slack", columns: [...MEMBER_COLUMNS, ...SLACK_COLUMNS] },
  { key: "users-without-orders", field: "slackWithoutOrders", title: "Slack users with no membership orders", columns: ["email", ...SLACK_COLUMNS] },
];

/** The consolidations page's two tables; `key` names each one's CSV download. */
const CONSOLIDATION_TABLES = [
  {
    key: "attributed-orders",
    title: "Orders attributed to another address",
    columns: ["order_id", "first_name", "last_name", "order_email", "member_email", "created_on", "attributed_at", "attributed_by", "note"],
    headings: ["Order", "First name", "Last name", "Order email", "Attributed to", "Started", "Changed (UTC)", "Changed by", "Note"],
  },
  {
    key: "duplicate-names",
    title: "Billing names under more than one address",
    columns: ["name", "member_email", "orders", "latest_expires"],
    headings: ["Name", "Attributed to", "Orders", "Latest expiry"],
  },
] as const;

class BadRequest extends Error {}

/** A real calendar date in `YYYY-MM-DD` form, or null. */
interface ReportRequest {
  /** `YYYY-MM-DD` as typed, or empty for "right now". */
  asOfDate: string;
  /** The instant the report is evaluated at. */
  asOf: string;
  filters: ReportFilters;
  page: number;
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
  const page = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequest("page must be a positive whole number");
  }
  return {
    asOfDate,
    asOf: asOfDate ? `${asOfDate}T23:59:59Z` : toIsoSeconds(now),
    filters: { search: query.q, channel: query.channel || undefined },
    page,
    csv: query.format === "csv",
  };
}

/** The current report URL, filters kept, plus `changes` (a page number or format). */
function withParams(
  path: string,
  req: ReportRequest,
  changes: Record<string, string>,
): string {
  const params = new URLSearchParams();
  const current: Record<string, string> = {
    as_of: req.asOfDate,
    q: req.filters.search?.trim() ?? "",
    channel: req.filters.channel ?? "",
    ...changes,
  };
  for (const [key, value] of Object.entries(current)) {
    if (value) params.set(key, value);
  }
  return `${path}?${params.toString()}`;
}

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
      Name or email contains
      <br />
      <input type="search" name="q" value={req.filters.search ?? ""} />
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

const OrdersTable: FC<{ rows: MembershipOrderRow[] }> = ({ rows }) => (
  <div style="overflow-x: auto">
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <thead>
        <tr>
          {["Order", "Name", "Order email", "Member email", "Started", "Expires", "Channel", "Status"].map(
            (heading) => (
              <th style={cellStyle}>{heading}</th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td style={cellStyle}>
              <a href={orderPath(row.order_id)}>{row.order_id}</a>
            </td>
            <td style={cellStyle}>{`${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()}</td>
            <td style={cellStyle}>{row.order_email}</td>
            <td style={cellStyle}>{row.member_email === row.order_email ? "" : row.member_email}</td>
            <td style={cellStyle}>{row.created_on.slice(0, 10)}</td>
            <td style={cellStyle}>{row.expires_on.slice(0, 10)}</td>
            <td style={cellStyle}>{row.channel_name ?? row.source}</td>
            <td style={cellStyle}>{row.status ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Pager: FC<{ path: string; req: ReportRequest; total: number }> = ({ path, req, total }) => {
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <p>
      Page {req.page} of {lastPage}
      {req.page > 1 && (
        <>
          {" · "}
          <a href={withParams(path, req, { page: String(req.page - 1) })}>Previous</a>
        </>
      )}
      {req.page < lastPage && (
        <>
          {" · "}
          <a href={withParams(path, req, { page: String(req.page + 1) })}>Next</a>
        </>
      )}
      {" · "}
      <a href={withParams(path, req, { format: "csv" })}>Download all {total} as CSV</a>
    </p>
  );
};

function csvResponse(name: string, req: ReportRequest, rows: MembershipOrderRow[]): Response {
  const stamp = req.asOf.slice(0, 10);
  return new Response(toCsv(ORDER_CSV_COLUMNS, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${stamp}.csv"`,
    },
  });
}

/** One consolidations cell: order ids link to their admin page, timestamps read as dates. */
function consolidationCell(row: AttributedOrderRow | DuplicateNameRow, column: string) {
  const value = row[column];
  if (column === "order_id") return <a href={orderPath(String(value))}>{String(value)}</a>;
  if (column === "attributed_at") {
    return value === null ? "legacy import" : new Date(Number(value)).toISOString().slice(0, 16).replace("T", " ");
  }
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

reports.get("/", (c) =>
  c.html(
    <AdminPage title="Membership reports">
      <ul>
        <li>
          <a href="/admin/reports/active">Active memberships</a>: every membership order in force today, or on
          any past date.
        </li>
        <li>
          <a href="/admin/reports/expired">Expired memberships</a>: members whose most recent membership has
          lapsed.
        </li>
        <li>
          <a href="/admin/reports/orders">Orders by month</a>: this year against last year.
        </li>
        <li>
          <a href="/admin/reports/consolidations">Consolidations</a>: memberships attributed to another address, and
          names under several addresses.
        </li>
        <li>
          <a href="/admin/reports/slack">Slack cross-reference</a>: current and lapsed members with and without
          Slack accounts, and Slack users who never bought a membership.
        </li>
        <li>
          <a href="/admin/reports/missing">Missing from BigCommerce</a>: orders the store no longer returns. They
          still count; this is the list to decide about.
        </li>
      </ul>
    </AdminPage>,
  ),
);

reports.get("/active", async (c) => {
  const path = "/admin/reports/active";
  const req = parseReportRequest(c.req.query(), new Date());
  if (req.csv) {
    const { rows } = await activeMemberships(c.env.DB, req.asOf, req.filters);
    return csvResponse("active-memberships", req, rows);
  }
  const [result, channels] = await Promise.all([
    activeMemberships(c.env.DB, req.asOf, req.filters, {
      limit: PAGE_SIZE,
      offset: (req.page - 1) * PAGE_SIZE,
    }),
    listChannels(c.env.DB),
  ]);
  return c.html(
    <AdminPage title="Active memberships">
      <p>Membership orders in force at the chosen moment. Unpaid, cancelled, refunded, and test orders are left out.</p>
      <FilterForm path={path} req={req} channels={channels} />
      <p>
        <strong>{result.totalMembers}</strong> members holding <strong>{result.totalOrders}</strong> orders, as of{" "}
        {req.asOf}.
      </p>
      <OrdersTable rows={result.rows} />
      <Pager path={path} req={req} total={result.totalOrders} />
    </AdminPage>,
  );
});

reports.get("/expired", async (c) => {
  const path = "/admin/reports/expired";
  const req = parseReportRequest(c.req.query(), new Date());
  if (req.csv) {
    const { rows } = await expiredMemberships(c.env.DB, req.asOf, req.filters);
    return csvResponse("expired-memberships", req, rows);
  }
  const [result, channels] = await Promise.all([
    expiredMemberships(c.env.DB, req.asOf, req.filters, {
      limit: PAGE_SIZE,
      offset: (req.page - 1) * PAGE_SIZE,
    }),
    listChannels(c.env.DB),
  ]);
  return c.html(
    <AdminPage title="Expired memberships">
      <p>
        Members whose most recent membership had expired at the chosen moment, shown by that most recent order. A
        member who renewed under a different email address is not listed.
      </p>
      <FilterForm path={path} req={req} channels={channels} />
      <p>
        <strong>{result.total}</strong> lapsed members, as of {req.asOf}.
      </p>
      <OrdersTable rows={result.rows} />
      <Pager path={path} req={req} total={result.total} />
    </AdminPage>,
  );
});

reports.get("/orders", async (c) => {
  const thisYear = new Date().getUTCFullYear();
  const raw = c.req.query("year");
  const year = raw === undefined || raw === "" ? thisYear : Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > thisYear + 1) {
    throw new BadRequest("year must be a four-digit year");
  }
  const months = await ordersByMonth(c.env.DB, year);
  if (c.req.query("format") === "csv") {
    return new Response(toCsv(["month", "orders", "previous_year_orders"], months), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="membership-orders-${year}.csv"`,
      },
    });
  }
  const total = months.reduce((sum, m) => sum + m.orders, 0);
  const previousTotal = months.reduce((sum, m) => sum + m.previous_year_orders, 0);
  return c.html(
    <AdminPage title={`Membership orders, ${year}`}>
      <p>
        <a href={`/admin/reports/orders?year=${year - 1}`}>← {year - 1}</a>
        {year < thisYear && (
          <>
            {" · "}
            <a href={`/admin/reports/orders?year=${year + 1}`}>{year + 1} →</a>
          </>
        )}
        {" · "}
        <a href={`/admin/reports/orders?year=${year}&format=csv`}>Download as CSV</a>
      </p>
      <table style="border-collapse: collapse">
        <thead>
          <tr>
            <th style={cellStyle}>Month (UTC)</th>
            <th style={cellStyle}>{year}</th>
            <th style={cellStyle}>{year - 1}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr>
              <td style={cellStyle}>{MONTH_NAMES[i]}</td>
              <td style={cellStyle}>{m.orders}</td>
              <td style={cellStyle}>{m.previous_year_orders}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th style={cellStyle}>Total</th>
            <th style={cellStyle}>{total}</th>
            <th style={cellStyle}>{previousTotal}</th>
          </tr>
        </tfoot>
      </table>
    </AdminPage>,
  );
});

/**
 * Current snapshot only: Slack accounts have no history, so a past date would
 * compare old memberships against today's workspace.
 */
reports.get("/slack", async (c) => {
  const asOf = toIsoSeconds(new Date());
  const format = c.req.query("format");
  const csvTable = format === "csv" ? SLACK_TABLES.find((t) => t.key === c.req.query("table")) : undefined;
  if (format === "csv" && !csvTable) {
    throw new BadRequest(`table must be one of ${SLACK_TABLES.map((t) => t.key).join(", ")}`);
  }
  const result = await slackCrossReference(c.env.DB, asOf);
  if (csvTable) {
    return new Response(toCsv(csvTable.columns, result[csvTable.field]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="slack-${csvTable.key}-${asOf.slice(0, 10)}.csv"`,
      },
    });
  }
  return c.html(
    <AdminPage title="Slack cross-reference">
      <p>
        Members matched to Slack accounts by email, as of {asOf}. Unpaid, cancelled, refunded, and test orders are left out;
        so are deactivated Slack accounts, bots, and accounts without an email. A member who joined Slack under a
        different address shows as not in Slack.
      </p>
      <p>
        {result.slackSyncedAt === null
          ? "The Slack sync has not run yet, so nobody shows as in Slack."
          : `Slack accounts last synced ${toIsoSeconds(new Date(result.slackSyncedAt))}.`}
      </p>
      {SLACK_TABLES.map((table) => {
        const rows = result[table.field];
        return (
          <section>
            <h2>
              {table.title} ({rows.length})
            </h2>
            <div style="overflow-x: auto">
              <table style="border-collapse: collapse; font-size: 0.9rem">
                <thead>
                  <tr>
                    {table.columns.map((column) => (
                      <th style={cellStyle}>{SLACK_COLUMN_HEADINGS[column]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PAGE_SIZE).map((row) => (
                    <tr>
                      {table.columns.map((column) => (
                        // Dates shown as days; the CSV keeps the full timestamp.
                        <td style={cellStyle}>{row[column]?.slice(0, column === "expires_on" ? 10 : undefined)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              {rows.length > PAGE_SIZE && `Showing the first ${PAGE_SIZE}. `}
              <a href={`/admin/reports/slack?table=${table.key}&format=csv`}>Download all {rows.length} as CSV</a>
            </p>
          </section>
        );
      })}
    </AdminPage>,
  );
});

/**
 * The legacy "Membership Consolidations" page: orders whose membership is
 * attributed to another address (by an admin, #70, or by the legacy import,
 * which knows each legacy user's current address), and billing names that
 * appear under several addresses -- one person with two accounts, probably.
 * Each order links to its admin page, where the attribution can be changed.
 */
reports.get("/consolidations", async (c) => {
  const format = c.req.query("format");
  const csvTable = format === "csv" ? CONSOLIDATION_TABLES.find((table) => table.key === c.req.query("table")) : undefined;
  if (format === "csv" && !csvTable) {
    throw new BadRequest(`table must be one of ${CONSOLIDATION_TABLES.map((table) => table.key).join(", ")}`);
  }
  const result = await consolidations(c.env.DB);
  const rowsFor = (key: string): (AttributedOrderRow | DuplicateNameRow)[] =>
    key === "attributed-orders" ? result.attributed : result.duplicateNames;
  if (csvTable) {
    return new Response(toCsv(csvTable.columns, rowsFor(csvTable.key)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="consolidations-${csvTable.key}-${toIsoSeconds(new Date()).slice(0, 10)}.csv"`,
      },
    });
  }
  return c.html(
    <AdminPage title="Consolidations">
      <p>
        Where a membership belongs to someone other than the address on its order, and where one billing name spans
        several addresses. Cancelled, refunded, and test orders are left out of the name comparison. Follow an order
        to change who it is attributed to.
      </p>
      {CONSOLIDATION_TABLES.map((table) => {
        const rows = rowsFor(table.key);
        return (
          <section>
            <h2>
              {table.title} ({rows.length})
            </h2>
            <div style="overflow-x: auto">
              <table style="border-collapse: collapse; font-size: 0.9rem">
                <thead>
                  <tr>
                    {table.headings.map((heading) => (
                      <th style={cellStyle}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PAGE_SIZE).map((row) => (
                    <tr>
                      {table.columns.map((column) => (
                        <td style={cellStyle}>{consolidationCell(row, column)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              {rows.length > PAGE_SIZE && `Showing the first ${PAGE_SIZE}. `}
              <a href={`/admin/reports/consolidations?table=${table.key}&format=csv`}>Download all {rows.length} as CSV</a>
            </p>
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
 * because deciding to withdraw somebody's membership is a judgement, and a
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
        -- nothing has been withdrawn from anyone. An order can vanish because it was deleted or archived in
        BigCommerce, and it can also vanish because the store had a bad day, so the flag clears itself if a later
        sync finds the order again.
      </p>
      {rows.length === 0 ? (
        <p>No orders are missing.</p>
      ) : (
        <div style="overflow-x: auto">
          <table style="border-collapse: collapse; font-size: 0.9rem">
            <thead>
              <tr>
                {["Order", "Member", "Name", "Status", "Membership", "First missed"].map((heading) => (
                  <th style={cellStyle}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: MissingOrderRow) => (
                <tr>
                  <td style={cellStyle}>
                    <a href={orderPath(row.order_id)}>{row.order_id}</a>
                  </td>
                  <td style={cellStyle}>{row.member_email}</td>
                  <td style={cellStyle}>{`${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()}</td>
                  <td style={cellStyle}>{row.status ?? ""}</td>
                  <td style={cellStyle}>
                    {row.counts ? `counts, to ${row.expires_on.slice(0, 10)}` : "doesn't count"}
                  </td>
                  <td style={cellStyle}>{new Date(row.missing_since).toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <a href="/admin/reports/missing?format=csv">Download CSV</a>
      </p>
    </AdminPage>,
  );
});

export default reports;
