import "../setup/d1";
import { STYLESHEET_PATH } from "../../src/styles";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { TABLE_FILTER_SCRIPT } from "../../src/admin/tableFilter";
import worker from "../../src/index";
import { insertCardName, insertMember, insertMemberSince, insertOrder, insertSlackUser } from "./fixtures";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;
/** More rows than the pages used to show at once (100), so nothing is cut short. */
const MANY = 101;

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
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("access control", () => {
  const PATHS = ["/admin/reports", "/admin/reports/active", "/admin/reports/expired", "/admin/reports/orders", "/admin/reports/slack", "/admin/reports/consolidations", "/admin/reports/missing", "/admin/reports/members"];

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

  it("ignores a name search from an old bookmark: the table's own filter box does that now", async () => {
    const body = await (await get(`/admin/reports/active?q=${encodeURIComponent('"><script>x</script>')}`)).text();

    expect(body).not.toContain("<script>x</script>");
    expect(body).not.toContain('name="q"');
    expect(body).toContain("<strong>1</strong> members");
  });

  it("escapes member-provided text in the table", async () => {
    await insertOrder({ id: "3", email: "xss@example.com", first: "<img src=x>", created: "2026-03-01T00:00:00Z" });

    const body = await (await get("/admin/reports/active")).text();

    expect(body).not.toContain("<img src=x>");
    expect(body).toContain("&lt;img src=x&gt;");
  });

  it("renders a sparse Squarespace-era row, falling back to the source for its channel", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, created_on, expires_on, first_seen_via, frozen_counts)
       VALUES ('5f00000000000000000000c3', 'squarespace', 'sparse@example.com', 'sparse@example.com',
               '2026-04-01T00:00:00Z', '2027-04-01T00:00:00Z', 'legacy_postgres', 1)`,
    ).run();

    const body = await (await get("/admin/reports/active")).text();

    // Shortened, so it does not widen the column; the whole id is in the
    // tooltip and behind the link.
    expect(body).toContain(
      '<a href="/admin/orders/5f00000000000000000000c3" title="5f00000000000000000000c3">5f0000…00c3</a>',
    );
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

  it("sends every row in one sortable table, with the CSV link above it", async () => {
    for (let i = 0; i < MANY; i++) {
      await insertOrder({ id: `bulk-${i}`, email: `bulk${i}@example.com`, created: "2026-02-01T00:00:00Z" });
    }

    // A page number from an old bookmark is ignored rather than refused.
    const body = await (await get("/admin/reports/active?page=2")).text();

    // Each address links to its member.
    expect(body.match(/<td[^>]*><a href="\/admin\/members\?q=bulk\d+%40example\.com">bulk\d+@example\.com<\/a><\/td>/g)).toHaveLength(MANY);
    expect(body).toContain("<table data-sortable");
    // The bulk orders and the one current order from beforeEach.
    const csvLink = body.indexOf(`href="/admin/reports/active?format=csv">Download all ${MANY + 1} as CSV`);
    expect(csvLink).toBeGreaterThan(-1);
    expect(csvLink).toBeLessThan(body.indexOf("<table"));
    expect(body).not.toContain("Page 1 of");
  });

  it("offers a box that narrows the table by any column, shown only once its script runs", async () => {
    await insertOrder({ id: "filter-1", email: "filter@example.com", created: "2026-02-01T00:00:00Z" });

    const body = await (await get("/admin/reports/active")).text();

    const scope = body.search(/<div data-table-filter[ =>]/);
    const box = body.search(/<p class="table-filter" data-filter-control[^>]* hidden[ =>]/);
    expect(scope).toBeGreaterThan(-1);
    // Below the CSV link, above the table, inside the same scope.
    expect(box).toBeGreaterThan(body.indexOf("as CSV</a>"));
    expect(box).toBeLessThan(body.indexOf("<table data-sortable"));
    expect(body.slice(box)).toMatch(/^[^]*?<input type="search"[^>]*\/>[^]*?<span data-filter-count[^>]* aria-live="polite">/);
    // Nothing typed there is sent anywhere: the box belongs to no form.
    expect(body.slice(box, body.indexOf("</p>", box))).not.toContain("name=");
    expect(body).toContain(TABLE_FILTER_SCRIPT);
  });

  it("offers no filter box where there is no table", async () => {
    const body = await (await get("/admin/reports/missing")).text();

    expect(body).not.toMatch(/<div data-table-filter[ =>]/);
  });

  it("downloads every matching row as CSV", async () => {
    for (let i = 0; i < MANY; i++) {
      await insertOrder({ id: `bulk-${i}`, email: `bulk${i}@example.com`, created: "2026-02-01T00:00:00Z" });
    }

    const res = await get("/admin/reports/active?format=csv");

    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="active-memberships-2026-06-01.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("order_id,first_name,last_name,order_email,member_email,created_on,expires_on,channel_name,source,status");
    expect(lines).toHaveLength(MANY + 2); // the header, the bulk orders and the current one
  });

  it.each([
    ["as_of=yesterday", "as_of"],
    ["as_of=2026-02-30", "as_of"],
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
    expect(body).toContain('<a href="/admin/members?q=lapsed%40example.com">lapsed@example.com</a>');
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
    expect(body).toMatch(/January<\/td><td[^>]*>1<\/td><td[^>]*>2<\/td>/);
    expect(body).toMatch(/Total<\/th><th[^>]*>1<\/th><th[^>]*>2<\/th>/);
    expect(body).toContain("/admin/reports/orders?year=2025");
    expect(body).not.toContain("year=2027");
  });

  it("shows an earlier year, with a link forward", async () => {
    const body = await (await get("/admin/reports/orders?year=2025")).text();

    expect(body).toMatch(/January<\/td><td[^>]*>0<\/td><td[^>]*>1<\/td>/);
    expect(body).toContain("/admin/reports/orders?year=2026");
  });

  it("treats an empty year as the current one", async () => {
    expect(await (await get("/admin/reports/orders?year=")).text()).toContain("Membership orders, 2026");
  });

  it("charts both years above the table, each bar titled with its figure", async () => {
    const body = await (await get("/admin/reports/orders")).text();

    expect(body).toContain('<figure class="month-chart">');
    expect(body).toContain("<title>Jan 2026: 2 orders</title>");
    expect(body).toContain("<title>Jan 2025: 1 order</title>");
    expect(body).toContain("<title>Dec 2026: 0 orders</title>");
    expect(body.match(/<rect /g)).toHaveLength(24);
    expect(body.indexOf("<svg")).toBeLessThan(body.indexOf("<table"));
    // Months sort by number, not by name, when the table is re-sorted.
    expect(body).toMatch(/data-sort="02"[^>]*>February<\/td>/);
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
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, created_on, expires_on, first_seen_via, frozen_counts)
       VALUES ('5f00000000000000000000d4', 'squarespace', 'nameless@example.com', 'nameless@example.com',
               '2026-04-01T00:00:00Z', '2027-04-01T00:00:00Z', 'legacy_postgres', 1)`,
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
    expect(body).toMatch(/<a href="\/admin\/members\?q=joined%40example\.com">joined@example\.com<\/a><\/td><td[^>]*>Jo<\/td><td[^>]*>Ined<\/td><td[^>]*>2027-01-10<\/td><td[^>]*>U01JOINED<\/td>/);
    expect(body).toContain("Current members not in Slack (1)");
    expect(body).toMatch(/nameless@example\.com<\/a><\/td><td[^>]*><\/td><td[^>]*><\/td><td[^>]*>2027-04-01<\/td><\/tr>/);
    expect(body).toContain("Lapsed members in Slack (1)");
    expect(body).toContain("&lt;img src=x&gt;");
    expect(body).not.toContain("<img src=x>");
    expect(body).toContain('<a href="/admin/members?q=lapsed%40example.com">lapsed@example.com</a>');
    expect(body).toContain("Slack users with no membership orders (1)");
    // A Slack account with no orders has no member to link to.
    expect(body).toMatch(/<td[^>]*>guest@example\.com<\/td>/);
    expect(body).toContain('href="/admin/reports/slack?table=users-without-orders&amp;format=csv">Download all 1 as CSV');
    expect(body).not.toContain("Showing the first");
  });

  it("says when the Slack sync has never run", async () => {
    await env.DB.exec("DELETE FROM slack_users");

    const body = await (await get("/admin/reports/slack")).text();

    expect(body).toContain("The Slack sync has not run yet");
    expect(body).toContain("Current members not in Slack (2)");
  });

  it("shows every row of a long table, as the CSV does", async () => {
    for (let i = 0; i < MANY; i++) {
      await insertSlackUser({ id: `UBULK${i}`, email: `bulk${i}@example.com` });
    }

    const body = await (await get("/admin/reports/slack")).text();
    const csv = await (await get("/admin/reports/slack?table=users-without-orders&format=csv")).text();

    expect(body).toContain(`Slack users with no membership orders (${MANY + 1})`);
    expect(body.match(/<td[^>]*>UBULK\d+<\/td>/g)).toHaveLength(MANY);
    expect(body).toContain("guest@example.com"); // sorts after every bulk address
    expect(csv.trimEnd().split("\r\n")).toHaveLength(MANY + 2);
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
    await insertMember({ id: "LV-1", email: "pat@example.com", first: "Pat", last: "Lee", memberSince: "2026-01-15" });
    await insertCardName({ email: "pat@example.com", name: "P. Lee", source: "admin", setBy: ADMIN_ID, note: "asked", at: 1700000000000 });
    await insertCardName({ email: "sam@example.com", name: "Sam", source: "member", at: 1600000000000 });
    await insertMemberSince({ email: "pat@example.com", date: "2018-06-01", source: "legacy_postgres", at: 1500000000000 });
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note, created_at)
       VALUES ('10', 'buyer@example.com', 'recipient@example.com', ?, 'gift', 1700000000000)`,
    )
      .bind(ADMIN_ID)
      .run();
  });

  it("shows all three tables, links each order to its admin page, and dates the change", async () => {
    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain("Orders attributed to another address (1)");
    expect(body).toContain('<a href="/admin/orders/10">10</a>');
    expect(body).toContain('<a href="/admin/members?q=buyer%40example.com">buyer@example.com</a>');
    expect(body).toContain('<a href="/admin/members?q=recipient%40example.com">recipient@example.com</a>');
    expect(body).toContain("2023-11-14 22"); // 1700000000000 ms
    // Who made the change is an admin, not a member.
    expect(body).toMatch(/<td[^>]*>admin@example\.com<\/td>/);
    expect(body).not.toContain("Billing names");
  });

  it("shows card names set by hand beside the name from the orders, and says who set each", async () => {
    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain("Card names set by hand (2)");
    const pat = body.slice(body.indexOf("Card names set by hand"));
    expect(pat).toMatch(
      /<a href="\/admin\/members\?q=pat%40example\.com">pat@example\.com<\/a><\/td><td[^>]*>P\. Lee<\/td><td[^>]*>Pat Lee<\/td><td[^>]*>differs<\/td><td[^>]*>admin@example\.com<\/td><td[^>]*>2023-11-14 22:13<\/td><td[^>]*>asked<\/td><td[^>]*><a href="\/admin\/orders\/11">11<\/a><\/td>/,
    );
    // A member who set their own name, with no card here: nothing to compare.
    expect(pat).toMatch(/>Sam<\/td><td[^>]*><\/td><td[^>]*>no card<\/td><td[^>]*>the member<\/td>/);
  });

  it("shows corrected member-since dates beside the date from the orders", async () => {
    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain("\u201cMember since\u201d corrections (1)");
    expect(body).toMatch(/>2018-06-01<\/td><td[^>]*>2026-01-15<\/td><td[^>]*>differs<\/td><td[^>]*>previous site<\/td>/);
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

    // The download keeps who set an override apart from how, and the raw values.
    const names = (await (await get("/admin/reports/consolidations?table=card-names&format=csv")).text()).split("\r\n");
    expect(names[0]).toBe("member_email,display_name,order_name,same_as_orders,source,set_by,set_at,note,order_id");
    expect(names).toContain("pat@example.com,P. Lee,Pat Lee,0,admin,admin@example.com,1700000000000,asked,11");

    const since = (await (await get("/admin/reports/consolidations?table=member-since&format=csv")).text()).split("\r\n");
    expect(since[0]).toBe("member_email,member_since,order_member_since,same_as_orders,source,set_by,set_at,note,order_id");
    expect(since[1]).toBe("pat@example.com,2018-06-01,2026-01-15,0,legacy_postgres,,1500000000000,,11");

    const bad = await get("/admin/reports/consolidations?table=duplicate-names&format=csv");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("table must be one of attributed-orders, card-names, member-since");
  });

  it("shows every row of a long table, with the full count in the CSV link above it", async () => {
    for (let i = 0; i < MANY; i++) {
      await insertOrder({ id: `dup-${i}`, email: `dup${i}@example.com`, memberEmail: `moved${i}@example.com`, created: "2026-01-15T00:00:00Z" });
    }

    const body = await (await get("/admin/reports/consolidations")).text();

    expect(body).toContain(`Orders attributed to another address (${MANY + 1})`);
    expect(body.match(/<a href="\/admin\/orders\/dup-\d+">/g)).toHaveLength(MANY);
    expect(body.indexOf(`Download all ${MANY + 1} as CSV`)).toBeLessThan(body.indexOf("<table"));
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
    expect(body).toContain('<a href="/admin/members?q=gone%40example.com">gone@example.com</a>');
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

  it("is listed on the reports index when something is missing", async () => {
    await insertOrder({ id: "22", email: "gone3@example.com", created: "2026-02-01T00:00:00Z" });
    await flag("22", Date.UTC(2026, 8, 17));

    expect(await (await get("/admin/reports")).text()).toContain('<a href="/admin/reports/missing">Missing from BigCommerce</a>');
  });
});

describe("orders carrying more than one membership", () => {
  // The report lists only active orders, so "now" is pinned rather than left
  // to whenever this runs; ACTIVE is an order still inside its year at NOW.
  const NOW = "2026-06-01T12:00:00Z";
  const ACTIVE = "2026-02-01T00:00:00Z";

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  });

  it("lists the order and links its member", async () => {
    await insertOrder({ id: "30", email: "several@example.com", created: ACTIVE });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 3 WHERE order_id = '30'").run();

    const body = await (await get("/admin/reports/extra-memberships")).text();

    expect(body).toContain('<a href="/admin/orders/30">30</a>');
    expect(body).toContain('<a href="/admin/members?q=several%40example.com">several@example.com</a>');
    expect(body).toMatch(/<td[^>]*>3<\/td>/);
    expect(body).not.toContain("Only orders that still count");
  });

  it("leaves off orders that were refunded or have run out, and says how many (#324)", async () => {
    await insertOrder({ id: "30", email: "current@example.com", created: ACTIVE });
    await insertOrder({ id: "31", email: "refunded@example.com", created: ACTIVE, status: "Refunded" });
    await insertOrder({ id: "32", email: "expired@example.com", created: "2020-02-01T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2").run();

    const body = await (await get("/admin/reports/extra-memberships")).text();

    expect(body).toContain("current@example.com");
    expect(body).not.toContain("refunded@example.com");
    expect(body).not.toContain("expired@example.com");
    expect(body).toContain("2 other orders carry more than one membership but have been refunded");
  });

  it("says so in the singular, and lists nothing, when the only such order has run out", async () => {
    await insertOrder({ id: "32", email: "expired@example.com", created: "2020-02-01T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2").run();

    const body = await (await get("/admin/reports/extra-memberships")).text();

    expect(body).toContain("No order carries more than one membership.");
    expect(body).toContain("1 other order carries more than one membership but has been refunded");
  });

  it("stops listing an order at the instant its membership ends", async () => {
    // Created a year before NOW, so it expires exactly at NOW: no longer active.
    await insertOrder({ id: "33", email: "ends.now@example.com", created: "2025-06-01T12:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2").run();

    const body = await (await get("/admin/reports/extra-memberships")).text();

    expect(body).not.toContain("ends.now@example.com");
    expect(body).toContain("1 other order carries more than one membership");
  });

  it("downloads only what the page lists", async () => {
    await insertOrder({ id: "30", email: "current@example.com", created: ACTIVE });
    await insertOrder({ id: "32", email: "expired@example.com", created: "2020-02-01T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2").run();

    const text = await (await get("/admin/reports/extra-memberships?format=csv")).text();

    expect(text).toContain("current@example.com");
    expect(text).not.toContain("expired@example.com");
  });
});

describe("the reports index, for the reports of things wanting action", () => {
  // Pinned, since whether an order carrying several memberships is listed
  // depends on it being active now.
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves both out when there is nothing in either", async () => {
    const body = await (await get("/admin/reports")).text();

    expect(body).not.toContain('href="/admin/reports/missing"');
    expect(body).not.toContain('href="/admin/reports/extra-memberships"');
    expect(body).toContain('<a href="/admin/reports/active">Active memberships</a>');
  });

  it("lists one as soon as it has something in it", async () => {
    await insertOrder({ id: "40", email: "several@example.com", created: "2026-02-01T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2").run();

    const body = await (await get("/admin/reports")).text();

    // The index's own entries, by their wording: the nav links the same
    // pages under shorter labels.
    expect(body).toContain('<a href="/admin/reports/extra-memberships">More than one membership</a>');
    expect(body).not.toContain(">Missing from BigCommerce</a>");
  });

  it("lists both when it cannot tell, rather than hiding something", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("AS extraMemberships")) throw new Error("D1 is having a bad day");
      return prepare(sql);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const body = await (await get("/admin/reports")).text();

    expect(body).toContain('<a href="/admin/reports/missing">Missing from BigCommerce</a>');
    expect(body).toContain('<a href="/admin/reports/extra-memberships">More than one membership</a>');
  });
});

describe("GET /admin/reports/members", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00Z"), toFake: ["Date"] });
    // Two members since 2024, one of whom lapsed; one who joined this year.
    await insertOrder({ id: "1", email: "long@example.com", created: "2024-03-15T00:00:00Z" });
    await insertOrder({ id: "2", email: "long@example.com", created: "2025-03-10T00:00:00Z" });
    await insertOrder({ id: "3", email: "long@example.com", created: "2026-03-01T00:00:00Z" });
    await insertOrder({ id: "4", email: "lapsed@example.com", created: "2024-07-01T00:00:00Z" });
    await insertOrder({ id: "5", email: "new@example.com", created: "2026-02-01T00:00:00Z" });
  });

  it("compares the last three years by default, with today's count against a year ago", async () => {
    const body = await (await get("/admin/reports/members")).text();

    expect(body).toContain("<strong>2</strong> active members today");
    // 1 Jun 2025: long, and lapsed before it lapsed a month later.
    expect(body).toContain("against <strong>2</strong> on this day last year");
    expect(body).toContain('<figure class="line-chart">');
    // One line per year, the latest in verde, and a column per year.
    expect(body.match(/<path class="line /g)).toHaveLength(3);
    expect(body).toContain('<path class="line latest"');
    expect(body).toMatch(/<th[^>]*>On the 1st of<\/th><th[^>]*>2024<\/th><th[^>]*>2025<\/th><th[^>]*>2026<\/th>/);
    expect(body).toMatch(/<input type="checkbox" name="year" value="2024" checked/);
  });

  it("gives the count on the first of each month, blank for months still to come", async () => {
    const body = await (await get("/admin/reports/members?year=2025&year=2026")).text();

    // 1 Jan 2025: long (bought 2024-03-15) and lapsed (2024-07-01).
    expect(body).toMatch(/>January<\/td><td[^>]*>2<\/td><td[^>]*>1<\/td>/);
    // 1 Jul 2025: lapsed has lapsed; 1 Jul 2026 has not happened yet.
    expect(body).toMatch(/>July<\/td><td[^>]*>1<\/td><td[^>]*><\/td>/);
    expect(body.match(/<path class="line /g)).toHaveLength(2);
  });

  it("shows every year as one line", async () => {
    const body = await (await get("/admin/reports/members?view=timeline")).text();

    expect(body.match(/<path class="line /g)).toHaveLength(1);
    expect(body).toContain("2024–2026");
    expect(body).toMatch(/<th[^>]*>2024<\/th><th[^>]*>2025<\/th><th[^>]*>2026<\/th>/);
    expect(body).toContain('<a href="/admin/reports/members">Compare years instead</a>');
  });

  it("refuses a year it has no orders for", async () => {
    const res = await get("/admin/reports/members?year=1999");

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("year must be one of 2024-2026");
  });

  it("downloads every day since the first order", async () => {
    const res = await get("/admin/reports/members?format=csv");
    const lines = (await res.text()).trimEnd().split("\r\n");

    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="active-members-by-day-2026-06-01.csv"');
    expect(lines[0]).toBe("date,active_members");
    expect(lines[1]).toBe("2024-03-15,1");
    expect(lines[lines.length - 1]).toBe("2026-06-01,2");
  });

  it("is listed on the reports index and in the nav", async () => {
    const body = await (await get("/admin/reports")).text();

    expect(body).toContain('<a href="/admin/reports/members">Active members over time</a>');
    expect(body).toContain('href="/admin/reports/members"');
  });
});
