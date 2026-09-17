import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { refreshMemberFromOrders } from "../../src/bigcommerce/sync";
import worker from "../../src/index";
import { insertOrder } from "./fixtures";

const ORIGIN = "https://card.losverd.es";
const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;

async function request(path: string, init: RequestInit & { as?: number | null } = {}) {
  const { as = ADMIN_ID, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (as !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: as, isAdmin: as === ADMIN_ID });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers, redirect: "manual" }), env, createExecutionContext());
}

function post(path: string, fields: Record<string, string>, options: { origin?: string | null; as?: number | null } = {}) {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  return request(path, { method: "POST", headers, body: new URLSearchParams(fields).toString(), as: options.as });
}

async function memberEmailOf(orderId: string) {
  return (await env.DB.prepare("SELECT member_email FROM membership_orders WHERE order_id = ?").bind(orderId).first<{ member_email: string }>())
    ?.member_email;
}

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'member@example.com', 0)").bind(MEMBER_ID).run();
  await insertOrder({ id: "1001_bc", email: "buyer@example.com", first: "Buy", last: "Er", created: "2098-01-15T00:00:00Z" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM slack_users");
  await env.DB.exec("DELETE FROM users");
});

describe("access control", () => {
  it("sends an anonymous visitor to log in", async () => {
    const res = await request("/admin/orders/1001_bc", { as: null });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("refuses a logged-in non-admin, for viewing and attributing alike", async () => {
    expect((await request("/admin/orders/1001_bc", { as: MEMBER_ID })).status).toBe(403);
    expect((await post("/admin/orders/1001_bc/member", { email: "x@example.com" }, { as: MEMBER_ID })).status).toBe(403);
    expect(await memberEmailOf("1001_bc")).toBe("buyer@example.com");
  });

  it("rejects a cross-site attribution POST", async () => {
    const res = await post("/admin/orders/1001_bc/member", { email: "x@example.com" }, { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(await memberEmailOf("1001_bc")).toBe("buyer@example.com");
  });
});

describe("GET /admin/orders/:orderId", () => {
  it("shows the order, an empty history, and the attribution form, uncached", async () => {
    const res = await request("/admin/orders/1001_bc");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Membership order 1001_bc");
    expect(body).toContain("buyer@example.com");
    expect(body).toContain("No attribution changes yet.");
    expect(body).toContain('<form method="get" action="/admin/orders/1001_bc">');
  });

  it("says so for an unknown order", async () => {
    const res = await request("/admin/orders/nope");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No membership order has the id nope.");
  });

  it("is linked from the report tables", async () => {
    const body = await (await request("/admin/reports/active?as_of=2098-06-01")).text();

    expect(body).toContain('<a href="/admin/orders/1001_bc">1001_bc</a>');
  });

  it("reviews an entered address, showing where it already appears, before anything changes", async () => {
    await insertOrder({ id: "2002_bc", email: "friend@example.com", created: "2098-03-01T00:00:00Z" });

    const res = await request("/admin/orders/1001_bc?email=%20Friend@Example.com%20&note=gift");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form method="post" action="/admin/orders/1001_bc/member">');
    expect(body).toContain('<input type="hidden" name="email" value="friend@example.com"/>');
    expect(body).toContain('<input type="hidden" name="note" value="gift"/>');
    expect(body).toContain("1 order(s) attributed to this address (1 counting as memberships); 1 placed with it");
    expect(body).not.toContain("appear anywhere yet");
    expect(await memberEmailOf("1001_bc")).toBe("buyer@example.com");
  });

  it("warns when a reviewed address appears nowhere", async () => {
    const body = await (await request("/admin/orders/1001_bc?email=typo@exmaple.com")).text();

    expect(body).toContain("appear anywhere yet");
    expect(body).toContain('<input type="hidden" name="note" value=""/>');
  });

  it("describes an admin login and a deactivated Slack account with no handle", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_users (slack_id, name, real_name, email, deleted, synced_at) VALUES ('U0DEACT', NULL, NULL, 'admin@example.com', 1, 0)",
    ).run();

    const body = await (await request("/admin/orders/1001_bc?email=admin@example.com")).text();

    expect(body).toContain("Has logged in (admin)");
    expect(body).toContain("Slack: U0DEACT (deactivated)");
  });

  it("describes an ordinary login", async () => {
    const body = await (await request("/admin/orders/1001_bc?email=member@example.com")).text();

    expect(body).toContain("<li>Has logged in</li>");
  });

  it("flags an order that doesn't count as a membership, and copes with missing fields", async () => {
    await insertOrder({ id: "3003_bc", email: "refunded@example.com", created: "2098-01-15T00:00:00Z", status: "Refunded" });
    await env.DB.exec("UPDATE membership_orders SET first_name = NULL, last_name = NULL, status = NULL, test_mode = 1 WHERE order_id = '3003_bc'");

    const body = await (await request("/admin/orders/3003_bc")).text();

    expect(body).toContain("(doesn&#39;t count as a membership)");
  });

  it("names a live Slack account by its handle", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_users (slack_id, name, real_name, email, deleted, synced_at) VALUES ('U0LIVE', 'friend', 'Friend', 'friend@example.com', 0, 0)",
    ).run();

    const body = await (await request("/admin/orders/1001_bc?email=friend@example.com")).text();

    expect(body).toContain("Slack: friend</li>");
    expect(body).toContain("Has never logged in");
  });

  it("shows history entries whose admin was since deleted, or that have no note", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note)
       VALUES ('1001_bc', 'buyer@example.com', 'friend@example.com', NULL, NULL)`,
    ).run();

    const body = await (await request("/admin/orders/1001_bc")).text();

    expect(body).toContain("friend@example.com");
    expect(body).not.toContain("No attribution changes yet.");
  });

  it.each([
    ["an invalid address", "email=not-an-email", "Enter a valid email address."],
    ["the current attribution", "email=buyer@example.com", "This order is already attributed to buyer@example.com."],
    ["an over-long note", `email=friend@example.com&note=${"x".repeat(501)}`, "Keep the note under 500 characters."],
  ])("re-shows the form with an error for %s", async (_label, query, message) => {
    const res = await request(`/admin/orders/1001_bc?${query}`);

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(message);
    expect(body).toContain('<form method="get" action="/admin/orders/1001_bc">');
  });
});

describe("POST /admin/orders/:orderId/member", () => {
  it("attributes the order, records who did it, and shows both members' cards", async () => {
    await refreshMemberFromOrders(env, "buyer@example.com", { firstName: "Buy", lastName: "Er", membershipTier: "standard" });

    const res = await post("/admin/orders/1001_bc/member", { email: " Friend@Example.com ", note: " gift " });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/orders/1001_bc?attributed_from=buyer%40example.com");
    expect(await memberEmailOf("1001_bc")).toBe("friend@example.com");
    expect(
      await env.DB.prepare("SELECT previous_member_email, member_email, admin_user_id, note FROM membership_order_attributions").first(),
    ).toEqual({ previous_member_email: "buyer@example.com", member_email: "friend@example.com", admin_user_id: ADMIN_ID, note: "gift" });

    const body = await (await request(res.headers.get("Location")!)).text();
    expect(body).toContain("Attributed to <strong>friend@example.com</strong> (previously buyer@example.com)");
    expect(body).toContain("Member card, current through");
    expect(body).toContain("Member card, but no current membership");
    expect(body).toContain("admin@example.com");
  });

  it("stores an empty note as none", async () => {
    await post("/admin/orders/1001_bc/member", { email: "friend@example.com", note: "   " });

    expect(await env.DB.prepare("SELECT note FROM membership_order_attributions").first()).toEqual({ note: null });
  });

  it("refuses an invalid attribution without changing anything", async () => {
    const res = await post("/admin/orders/1001_bc/member", { email: "buyer@example.com" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already attributed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM membership_order_attributions").first()).toEqual({ n: 0 });
  });

  it("refuses a submission missing its fields", async () => {
    const res = await post("/admin/orders/1001_bc/member", {});

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter a valid email address.");
  });

  it("404s for an unknown order", async () => {
    expect((await post("/admin/orders/nope/member", { email: "friend@example.com" })).status).toBe(404);
  });
});
