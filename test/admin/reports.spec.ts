import "../setup/d1";
import { STYLESHEET_PATH } from "../../src/styles";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE } from "../../src/admin/reports";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { insertOrder, insertSlackUser } from "./fixtures";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;

async function get(path: string, loggedInAs: number | null = ADMIN_ID) {
  const headers = new Headers();
  if (loggedInAs !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: loggedInAs, isAdmin: loggedInAs === ADMIN_ID });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'member@example.com', 0)").bind(MEMBER_ID).run();
});

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM users");
});

describe("access control", () => {
  const PATHS = ["/admin/reports", "/admin/reports/active", "/admin/reports/expired", "/admin/reports/orders", "/admin/reports/slack", "/admin/reports/consolidations", "/admin/reports/missing"];

  it.each(PATHS)("%s sends an anonymous visitor to log in", async (path) => {
    const res = await get(path, null);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login(\?|$)/);
  });

  it.each(PATHS)("%s refuses a logged-in non-admin", async (path) => {
    const res = await get(path, MEMBER_ID);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("example.com");
  });

  it.each(PATHS)("%s serves an admin, uncached", async (path) => {
    const res = await get(path);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /admin/reports/active", () => {
  beforeEach(async () => {
    await insertOrder({ id: "1", email: "current@example.com", first: "Cur", last: "Rent", created: "2026-01-10T00:00:00Z" });
    await insertOrder({ id: "2", email: "old.address@example.com", memberEmail: "moved@example.com", created: "2024-02-01T00:00:00Z", channel: "bigcommerce_iphone" });
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
  });

  it("defaults to right now", async () => {
    const body = await (await get("/admin/reports/active")).text();

    expect(body).toContain("as of 2026-06-01T12:00:00Z");
    expect(body).toContain("<strong>1</strong> members holding <strong>1</strong> orders");
    expect(body).toContain("current@example.com");
    expect(body).not.toContain("moved@example.com");
  });

  it("answers for a past date, through the end of that day, and shows a differing member email", async () => {
    const body = await (await get("/admin/reports/active?as_of=2024-02-01")).text();

    expect(body).toContain("as of 2024-02-01T23:59:59Z");
    expect(body).toContain("old.address@example.com");
    expect(body).toContain("moved@example.com");
    expect(body).toContain('value="2024-02-01"');
  });

  it("offers the channels as a filter, keeping the chosen one selected", async () => {
    const body = await (await get("/admin/reports/active?as_of=2024-06-01&channel=bigcommerce_iphone")).text();

    expect(body).toMatch(/<option value="bigcommerce_iphone" selected[^>]*>bigcommerce_iphone<\/option>/);
    expect(body).toContain('<option value="bigcommerce_www">');
    expect(body).toContain("old.address@example.com");
  });

  it("applies the search filter and escapes it when echoing it back", async () => {
    const body = await (await get(`/admin/reports/active?q=${encodeURIComponent('"><script>x</script>')}`)).text();

    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("<strong>0</strong> members");
  });

  it("escapes member-provided text in the table", async () => {
    await insertOrder({ id: "3", email: "xss@example.com", first: "<img src=x>", created: "2026-03-01T00:00:00Z" });

    const body = await (await get("/admin/reports/active")).text();

    expect(body).not.toContain("<img src=x>");
    expect(body).toContain("&lt;img src=x&gt;");
  });

  it("renders a sparse Squarespace-era row, falling back to the source for its channel", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, created_on, expires_on, first_seen_via)
       VALUES ('5f00000000000000000000c3', 'squarespace', 'sparse@example.com', 'sparse@example.com',
               '2026-04-01T00:00:00Z', '2027-04-01T00:00:00Z', 'legacy_postgres')`,
    ).run();

    const body = await (await get("/admin/reports/active?q=sparse")).text();

    expect(body).toContain("5f00000000000000000000c3");
    expect(body).toMatch(/>squarespace<\/td>/);
  });

  it("doesn't disguise an unexpected failure as a bad request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("D1 is down"));

    const res = await get("/admin/reports/active");

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("D1 is down");
    vi.restoreAllMocks();
  });

  it("pages, carrying the filters along in the links", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      await insertOrder({ id: `bulk-${i}`, email: `bulk${i}@example.com`, created: "2026-02-01T00:00:00Z" });
    }

    const first = await (await get("/admin/reports/active?q=bulk")).text();
    const second = await (await get("/admin/reports/active?q=bulk&page=2")).text();

    expect(first).toContain("Page 1 of 2");
    expect(first).toContain('href="/admin/reports/active?q=bulk&amp;page=2">Next');
    expect(first).not.toContain("Previous");
    expect(second).toContain("Page 2 of 2");
    expect(second).toContain('href="/admin/reports/active?q=bulk&amp;page=1">Previous');
    expect(second).not.toContain(">Next<");
    expect(second.match(/bulk\d+@example\.com/g)).toHaveLength(1);
  });

  it("downloads every matching row as CSV, not just one page", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      await insertOrder({ id: `bulk-${i}`, email: `bulk${i}@example.com`, created: "2026-02-01T00:00:00Z" });
    }

    const res = await get("/admin/reports/active?q=bulk&format=csv");

    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="active-memberships-2026-06-01.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("order_id,first_name,last_name,order_email,member_email,created_on,expires_on,channel_name,source,status");
    expect(lines).toHaveLength(PAGE_SIZE + 2);
  });

  it.each([
    ["as_of=yesterday", "as_of"],
    ["as_of=2026-02-30", "as_of"],
    ["page=0", "page"],
    ["page=1.5", "page"],
    ["page=abc", "page"],
  ])("rejects %s", async (query, field) => {
    const res = await get(`/admin/reports/active?${query}`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain(field);
  });
});

describe("GET /admin/reports/expired", () => {
  beforeEach(async () => {
    await insertOrder({ id: "1", email: "lapsed@example.com", created: "2024-03-01T00:00:00Z" });
    await insertOrder({ id: "2", email: "current@example.com", created: "2026-01-10T00:00:00Z" });
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
  });

  it("lists lapsed members only", async () => {
    const body = await (await get("/admin/reports/expired")).text();

    expect(body).toContain("<strong>1</strong> lapsed members, as of 2026-06-01T12:00:00Z");
    expect(body).toContain("lapsed@example.com");
    expect(body).not.toContain("current@example.com");
  });

  it("downloads as CSV, named for the chosen date", async () => {
    const res = await get("/admin/reports/expired?as_of=2025-12-31&format=csv");

    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="expired-memberships-2025-12-31.csv"');
    expect(await res.text()).toContain("lapsed@example.com");
  });

  it("rejects a bad date", async () => {
    expect((await get("/admin/reports/expired?as_of=nope")).status).toBe(400);
  });
});

describe("GET /admin/reports/orders", () => {
  beforeEach(async () => {
    await insertOrder({ id: "1", email: "a@example.com", created: "2026-01-10T00:00:00Z" });
    await insertOrder({ id: "2", email: "b@example.com", created: "2026-01-20T00:00:00Z" });
    await insertOrder({ id: "3", email: "c@example.com", created: "2025-01-05T00:00:00Z" });
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
  });

  it("defaults to the current year, with totals and a link back but not forward", async () => {
    const body = await (await get("/admin/reports/orders")).text();

    expect(body).toContain("Membership orders, 2026");
    expect(body).toMatch(/January<\/td><td[^>]*>2<\/td><td[^>]*>1<\/td>/);
    expect(body).toMatch(/Total<\/th><th[^>]*>2<\/th><th[^>]*>1<\/th>/);
    expect(body).toContain("/admin/reports/orders?year=2025");
    expect(body).not.toContain("year=2027");
  });

  it("shows an earlier year, with a link forward", async () => {
    const body = await (await get("/admin/reports/orders?year=2025")).text();

    expect(body).toMatch(/January<\/td><td[^>]*>1<\/td><td[^>]*>0<\/td>/);
    expect(body).toContain("/admin/reports/orders?year=2026");
  });

  it("treats an empty year as the current one", async () => {
    expect(await (await get("/admin/reports/orders?year=")).text()).toContain("Membership orders, 2026");
  });

  it("downloads as CSV", async () => {
    const res = await get("/admin/reports/orders?year=2026&format=csv");

    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="membership-orders-2026.csv"');
    expect((await res.text()).split("\r\n").slice(0, 2)).toEqual(["month,orders,previous_year_orders", "01,2,1"]);
  });

  it.each(["year=26", "year=1999", "year=2028", "year=soon"])("rejects %s", async (query) => {
    expect((await get(`/admin/reports/orders?${query}`)).status).toBe(400);
  });
});

describe("GET /admin/reports/slack", () => {
  beforeEach(async () => {
    await insertOrder({ id: "1", email: "joined@example.com", first: "Jo", last: "Ined", created: "2026-01-10T00:00:00Z" });
    await insertOrder({ id: "2", email: "lapsed@example.com", created: "2024-03-01T00:00:00Z" });
    // A sparse Squarespace-era member with no billing name, not in Slack.
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, created_on, expires_on, first_seen_via)
       VALUES ('5f00000000000000000000d4', 'squarespace', 'nameless@example.com', 'nameless@example.com',
               '2026-04-01T00:00:00Z', '2027-04-01T00:00:00Z', 'legacy_postgres')`,
    ).run();
    await insertSlackUser({ id: "U01JOINED", email: "joined@example.com", realName: "Jo Ined" });
    await insertSlackUser({ id: "U02LAPSED", email: "lapsed@example.com", realName: "<img src=x>" });
    await insertSlackUser({ id: "U03GUEST", email: "guest@example.com", realName: "=HYPERLINK(1)" });
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
  });

  afterEach(async () => {
    await env.DB.exec("DELETE FROM slack_users");
  });

  it("shows all four tables, with counts, dates as days, and the last sync time", async () => {
    const body = await (await get("/admin/reports/slack")).text();

    expect(body).toContain("as of 2026-06-01T12:00:00Z");
    expect(body).toContain("Slack accounts last synced 2026-06-01T00:00:00Z.");
    expect(body).toContain("Current members in Slack (1)");
    expect(body).toMatch(/joined@example\.com<\/td><td[^>]*>Jo<\/td><td[^>]*>Ined<\/td><td[^>]*>2027-01-10<\/td><td[^>]*>U01JOINED<\/td>/);
    expect(body).toContain("Current members not in Slack (1)");
    expect(body).toMatch(/nameless@example\.com<\/td><td[^>]*><\/td><td[^>]*><\/td><td[^>]*>2027-04-01<\/td><\/tr>/);
    expect(body).toContain("Lapsed members in Slack (1)");
    expect(body).toContain("&lt;img src=x&gt;");
    expect(body).not.toContain("<img src=x>");
    expect(body).toContain("Slack users with no membership orders (1)");
    expect(body).toContain('href="/admin/reports/slack?table=users-without-orders&amp;format=csv">Download all 1 as CSV');
    expect(body).not.toContain("Showing the first");
  });

  it("says when the Slack sync has never run", async () => {
    await env.DB.exec("DELETE FROM slack_users");

    const body = await (await get("/admin/reports/slack")).text();

    expect(body).toContain("The Slack sync has not run yet");
    expect(body).toContain("Current members not in Slack (2)");
  });

  it("shows only the first page of a long table, but downloads all of it", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      await insertSlackUser({ id: `UBULK${i}`, email: `bulk${i}@example.com` });
    }

    const body = await (await get("/admin/reports/slack")).text();
    const csv = await (await get("/admin/reports/slack?table=users-without-orders&format=csv")).text();

    expect(body).toContain(`Slack users with no membership orders (${PAGE_SIZE + 2})`);
    expect(body).toContain(`Showing the first ${PAGE_SIZE}.`);
    expect(body.match(/<td[^>]*>UBULK\d+<\/td>/g)).toHaveLength(PAGE_SIZE);
    expect(body).not.toContain("guest@example.com"); // sorts after every bulk address
    expect(csv.trimEnd().split("\r\n")).toHaveLength(PAGE_SIZE + 3);
    expect(csv).toContain("guest@example.com");
  });

  it("downloads one table as CSV, with that table's columns", async () => {
    const res = await get("/admin/reports/slack?table=users-without-orders&format=csv");

    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="slack-users-without-orders-2026-06-01.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.text()).split("\r\n").slice(0, 2)).toEqual(["email,slack_id,slack_name", "guest@example.com,U03GUEST,'=HYPERLINK(1)"]);

    const current = await (await get("/admin/reports/slack?table=current-in-slack&format=csv")).text();
    expect(current.split("\r\n").slice(0, 2)).toEqual([
      "email,first_name,last_name,expires_on,slack_id,slack_name",
      "joined@example.com,Jo,Ined,2027-01-10T00:00:00Z,U01JOINED,Jo Ined",
    ]);
  });

  it.each(["format=csv", "format=csv&table=everyone"])("rejects %s", async (query) => {
    const res = await get(`/admin/reports/slack?${query}`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("table must be one of current-in-slack");
  });
});

describe("GET /admin/reports/consolidations", () => {
  beforeEach(async () => {
    await insertOrder({ id: "10", email: "buyer@example.com", memberEmail: "recipient@example.com", first: "Buy", last: "Er", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "11", email: "pat@example.com", first: "Pat", last: "Lee", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "12", email: "p.lee@example.com", first: "Pat", last: "Lee", created: "2025-01-15T00:00:00Z" });
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note, created_at)
       VALUES ('10', 'buyer@example.com', 'recipient@example.com', ?, 'gift', 1700000000000)`,
    )
      .bind(ADMIN_ID)
      .run();
  });

  it("shows both tables, links each order to its admin page, and dates the change", async () => {
    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain("Orders attributed to another address (1)");
    expect(body).toContain('<a href="/admin/orders/10">10</a>');
    expect(body).toContain("recipient@example.com");
    expect(body).toContain("2023-11-14 22"); // 1700000000000 ms
    expect(body).toContain("admin@example.com");
    expect(body).toContain("Billing names under more than one address (2)");
    expect(body).toContain("pat lee");
  });

  it("marks an attribution the legacy import made, rather than an admin", async () => {
    await env.DB.exec("DELETE FROM membership_order_attributions");

    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain("legacy import");
  });

  it("downloads each table as CSV, and rejects an unknown table", async () => {
    const attributed = await get("/admin/reports/consolidations?table=attributed-orders&format=csv");
    expect(attributed.headers.get("Content-Disposition")).toContain('filename="consolidations-attributed-orders-');
    const csv = await attributed.text();
    expect(csv).toContain("order_id,first_name,last_name,order_email,member_email,created_on,attributed_at,attributed_by,note");
    expect(csv).toContain("10,Buy,Er,buyer@example.com,recipient@example.com");

    const names = await get("/admin/reports/consolidations?table=duplicate-names&format=csv");
    expect(await names.text()).toContain("pat lee,p.lee@example.com,1,");

    const bad = await get("/admin/reports/consolidations?table=nope&format=csv");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("table must be one of attributed-orders, duplicate-names");
  });

  it("shows only the first page of a long table, with the full count in the CSV link", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      await insertOrder({ id: `dup-${i}`, email: `dup${i}@example.com`, memberEmail: `moved${i}@example.com`, created: "2026-01-15T00:00:00Z" });
    }

    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain(`Orders attributed to another address (${PAGE_SIZE + 2})`);
    expect(body).toContain(`Showing the first ${PAGE_SIZE}.`);
    expect(body).toContain(`Download all ${PAGE_SIZE + 2} as CSV`);
  });

  it("is listed on the reports index", async () => {
    expect(await (await get("/admin/reports")).text()).toContain('<a href="/admin/reports/consolidations">Consolidations</a>');
  });
});

describe("branding", () => {
  it("links the same stylesheet the member pages use", async () => {
    const html = await (await get("/admin/reports")).text();

    expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET_PATH}"`);
    expect(html).toContain('<body class="admin">');
  });
});

describe("missing from BigCommerce", () => {
  async function flag(orderId: string, missingSince: number) {
    await env.DB.prepare("UPDATE membership_orders SET missing_since = ? WHERE order_id = ?")
      .bind(missingSince, orderId)
      .run();
  }

  it("says so plainly when nothing is missing", async () => {
    expect(await (await get("/admin/reports/missing")).text()).toContain("No orders are missing");
  });

  it("lists a missing order and states that it still counts", async () => {
    // The page has one job beyond listing: not reading as though something
    // has already been taken away from the member.
    await insertOrder({ id: "20", email: "gone@example.com", first: "Gone", last: "Order", created: "2026-02-01T00:00:00Z" });
    await flag("20", Date.UTC(2026, 8, 17));

    const body = await (await get("/admin/reports/missing")).text();

    expect(body).toContain("20");
    expect(body).toContain("gone@example.com");
    expect(body).toContain("still count");
    expect(body).toContain("2026-09-17");
    expect(body).toContain("counts, to 2027-02-01");
  });

  it("downloads as CSV", async () => {
    await insertOrder({ id: "21", email: "gone2@example.com", created: "2026-02-01T00:00:00Z" });
    await flag("21", Date.UTC(2026, 8, 17));

    const res = await get("/admin/reports/missing?format=csv");

    expect(res.headers.get("Content-Disposition")).toContain('filename="missing-orders-');
    expect(await res.text()).toContain("21,gone2@example.com");
  });

  it("is listed on the reports index", async () => {
    expect(await (await get("/admin/reports")).text()).toContain('<a href="/admin/reports/missing">Missing from BigCommerce</a>');
  });
});
