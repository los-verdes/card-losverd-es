import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { AdminNav } from "../../src/admin/nav";
import { toIsoSeconds } from "../../src/bigcommerce/orders";
import { missingOrders, ordersWithExtraMemberships } from "../../src/admin/reportQueries";
import worker from "../../src/index";
import { insertOrder } from "./fixtures";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(ADMIN_ID, "admin@example.com")
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM users");
});

async function get(path: string) {
  const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      redirect: "manual",
    }),
    env,
    createExecutionContext(),
  );
}

/** Every `href` inside the admin shell's `<nav>`. */
function navLinks(html: string): string[] {
  const nav = html.match(/<nav class="admin-nav">([\s\S]*?)<\/nav>/);
  expect(nav, "the admin shell should render a nav").not.toBeNull();
  return [...nav![1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe("the admin navigation", () => {
  it("points every link at something that exists", async () => {
    // The failure this catches is a link added alongside a route that landed
    // in a different pull request, or outlived one that was renamed. Neither
    // shows up in a type check, and both look fine until somebody clicks.
    const html = await (await get("/admin/reports")).text();
    const links = navLinks(html);
    expect(links.length).toBeGreaterThan(8);

    const statuses = await Promise.all(
      links.map(async (href) => [href, (await get(href)).status] as const),
    );

    expect(statuses.filter(([, status]) => status === 404)).toEqual([]);
  });

  it("groups the links rather than running them together", async () => {
    // Eleven links in one row read as a wall. Each group carries the shared
    // word so the links inside it only say what makes them different.
    const html = await (await get("/admin/reports")).text();

    const labels = [...html.matchAll(/class="nav-label">([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Reports", "Needs a look", "Members", "This environment"]);
  });

  it("is on every admin page, not just the reports index", async () => {
    for (const path of ["/admin/members", "/admin/member-since", "/admin/revocations"]) {
      const html = await (await get(path)).text();
      expect(navLinks(html).length, `${path} should carry the nav`).toBeGreaterThan(8);
    }
  });
});

/** The `<a>` for one nav link, whole, so its class and badge can be read. */
function navAnchor(html: string, href: string): string {
  const anchor = html.match(new RegExp(`<a href="${href}"[^>]*>[^]*?</a>`));
  expect(anchor, `the nav should link ${href}`).not.toBeNull();
  return anchor![0];
}

describe("the links to reports of things wanting action", () => {
  const MISSING = "/admin/reports/missing";
  const EXTRA = "/admin/reports/extra-memberships";

  it("step back when there is nothing in them", async () => {
    const html = await (await get("/admin/members")).text();

    for (const href of [MISSING, EXTRA]) {
      expect(navAnchor(html, href)).toContain('class="nav-quiet"');
      expect(navAnchor(html, href)).not.toContain("nav-count");
    }
  });

  it("carry a count of what there is when there is something", async () => {
    await insertOrder({ id: "1001", email: "a@example.com", created: "2026-01-10T00:00:00Z" });
    await insertOrder({ id: "1002", email: "b@example.com", created: "2026-02-10T00:00:00Z" });
    // Far off, so it is still in force whenever this runs: the report lists only those (#324).
    await insertOrder({ id: "1003", email: "c@example.com", created: "2098-03-10T00:00:00Z" });
    await env.DB.prepare(
      "UPDATE membership_orders SET missing_since = 1700000000000 WHERE order_id IN ('1001', '1002')",
    ).run();
    await env.DB.prepare("UPDATE membership_orders SET membership_units = 2 WHERE order_id = '1003'").run();

    const html = await (await get("/admin/members")).text();

    expect(navAnchor(html, MISSING)).toMatch(/class="nav-count"[^>]*>2</);
    expect(navAnchor(html, EXTRA)).toMatch(/class="nav-count"[^>]*>1</);
    expect(navAnchor(html, MISSING)).not.toContain("nav-quiet");
  });

  it("count exactly what the reports themselves list", async () => {
    // The nav counts with its own query, so the two could drift apart. A
    // badge saying 2 over a report listing 3 is worse than no badge.
    await insertOrder({ id: "1001", email: "a@example.com", created: "2098-01-10T00:00:00Z" });
    await insertOrder({ id: "1002", email: "b@example.com", created: "2098-02-10T00:00:00Z", status: "Refunded" });
    await insertOrder({ id: "1004", email: "d@example.com", created: "2020-02-10T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET missing_since = 1700000000000, membership_units = 3").run();

    const html = await (await get("/admin/members")).text();

    expect(navAnchor(html, MISSING)).toContain(`>${(await missingOrders(env.DB)).length}<`);
    expect(navAnchor(html, EXTRA)).toContain(`>${(await ordersWithExtraMemberships(env.DB, toIsoSeconds(new Date()))).length}<`);
  });

  it("fall back to plain links, rather than failing the page, when the count fails", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("AS extraMemberships")) throw new Error("D1 is having a bad day");
      return prepare(sql);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await get("/admin/members");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(navAnchor(html, MISSING)).toBe(`<a href="${MISSING}">Missing orders</a>`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Admin nav"), expect.any(Error));
  });

  it("render plainly outside a request, where there is nothing to count with", async () => {
    const html = String(await AdminNav({}));

    expect(navAnchor(html, MISSING)).toBe(`<a href="${MISSING}">Missing orders</a>`);
  });
});
