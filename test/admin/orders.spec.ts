import "../setup/d1";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { getTestCertChain } from "../fixtures/certChain";
import { fakeEmailBinding, recipientOf, type FakeEmailBinding } from "../fixtures/emailBinding";
import LOGO from "../fixtures/sample-logo.png";
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
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers, redirect: "manual" }), env, ctx);
  // Flushes the card email's waitUntil.
  await waitOnExecutionContext(ctx);
  return res;
}

/** What the `send_email` binding was handed, per test. */
let email: FakeEmailBinding;

/**
 * Any outbound fetch fails the test. Attributing an order and emailing its
 * card make none: mail goes through `env.EMAIL`, the fake binding.
 */
function forbidFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
  });
}

/** Who the binding was asked to email. */
function sentTo() {
  return email.sent.map(recipientOf);
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
  await insertOrder({ id: "1001", email: "buyer@example.com", first: "Buy", last: "Er", created: "2098-01-15T00:00:00Z" });
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
    const res = await request("/admin/orders/1001", { as: null });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login(\?|$)/);
  });

  it("refuses a logged-in non-admin, for viewing and attributing alike", async () => {
    expect((await request("/admin/orders/1001", { as: MEMBER_ID })).status).toBe(403);
    expect((await post("/admin/orders/1001/member", { email: "x@example.com" }, { as: MEMBER_ID })).status).toBe(403);
    expect(await memberEmailOf("1001")).toBe("buyer@example.com");
  });

  it("rejects a cross-site attribution POST", async () => {
    const res = await post("/admin/orders/1001/member", { email: "x@example.com" }, { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(await memberEmailOf("1001")).toBe("buyer@example.com");
  });
});

describe("GET /admin/orders/:orderId", () => {
  it("shows the order, an empty history, and the attribution form, uncached", async () => {
    const res = await request("/admin/orders/1001");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Membership order 1001");
    expect(body).toContain("buyer@example.com");
    expect(body).toContain("No attribution changes yet.");
    expect(body).toContain('<form method="get" action="/admin/orders/1001">');
  });

  it("says so for an unknown order", async () => {
    const res = await request("/admin/orders/nope");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No membership order has the id nope.");
  });

  it("is linked from the report tables", async () => {
    const body = await (await request("/admin/reports/active?as_of=2098-06-01")).text();

    expect(body).toContain('<a href="/admin/orders/1001">1001</a>');
  });

  it("reviews an entered address, showing where it already appears, before anything changes", async () => {
    await insertOrder({ id: "2002", email: "friend@example.com", created: "2098-03-01T00:00:00Z" });

    const res = await request("/admin/orders/1001?email=%20Friend@Example.com%20&note=gift");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form method="post" action="/admin/orders/1001/member">');
    expect(body).toContain('<input type="hidden" name="email" value="friend@example.com"/>');
    expect(body).toContain('<input type="hidden" name="note" value="gift"/>');
    expect(body).toContain("1 order(s) attributed to this address (1 counting as memberships); 1 placed with it");
    expect(body).not.toContain("appear anywhere yet");
    expect(await memberEmailOf("1001")).toBe("buyer@example.com");
  });

  it("says no card email will go out when the order does not count as a membership", async () => {
    await insertOrder({ id: "4004", email: "refunded@example.com", created: "2098-01-15T00:00:00Z", status: "Refunded" });

    const body = await (await request("/admin/orders/4004?email=friend@example.com")).text();

    expect(body).toContain("nothing will be sent");
  });

  it("says when the store no longer has the order, without implying it was revoked", async () => {
    await env.DB.prepare("UPDATE membership_orders SET missing_since = ? WHERE order_id = '1001'")
      .bind(Date.UTC(2026, 8, 17))
      .run();

    const body = await (await request("/admin/orders/1001")).text();

    expect(body).toContain("No longer returned by the store");
    expect(body).toContain("2026-09-17");
    expect(body).toContain("It still counts");
  });

  it("warns when a reviewed address appears nowhere", async () => {
    const body = await (await request("/admin/orders/1001?email=typo@exmaple.com")).text();

    expect(body).toContain("appear anywhere yet");
    expect(body).toContain('<input type="hidden" name="note" value=""/>');
  });

  it("describes an admin login and a deactivated Slack account with no handle", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_users (slack_id, name, real_name, email, deleted, synced_at) VALUES ('U0DEACT', NULL, NULL, 'admin@example.com', 1, 0)",
    ).run();

    const body = await (await request("/admin/orders/1001?email=admin@example.com")).text();

    expect(body).toContain("Has logged in (admin)");
    expect(body).toContain("Slack: U0DEACT (deactivated)");
  });

  it("describes an ordinary login", async () => {
    const body = await (await request("/admin/orders/1001?email=member@example.com")).text();

    expect(body).toContain("<li>Has logged in</li>");
  });

  it("flags an order that doesn't count as a membership, and copes with missing fields", async () => {
    await insertOrder({ id: "3003", email: "refunded@example.com", created: "2098-01-15T00:00:00Z", status: "Refunded" });
    await env.DB.exec("UPDATE membership_orders SET first_name = NULL, last_name = NULL, status = NULL WHERE order_id = '3003'");

    const body = await (await request("/admin/orders/3003")).text();

    expect(body).toContain("(doesn&#39;t count as a membership)");
  });

  it("names a live Slack account by its handle", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_users (slack_id, name, real_name, email, deleted, synced_at) VALUES ('U0LIVE', 'friend', 'Friend', 'friend@example.com', 0, 0)",
    ).run();

    const body = await (await request("/admin/orders/1001?email=friend@example.com")).text();

    expect(body).toContain("Slack: friend</li>");
    expect(body).toContain("Has never logged in");
  });

  it("shows history entries whose admin was since deleted, or that have no note", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note)
       VALUES ('1001', 'buyer@example.com', 'friend@example.com', NULL, NULL)`,
    ).run();

    const body = await (await request("/admin/orders/1001")).text();

    expect(body).toContain("friend@example.com");
    expect(body).not.toContain("No attribution changes yet.");
  });

  it.each([
    ["an invalid address", "email=not-an-email", "Enter a valid email address."],
    ["the current attribution", "email=buyer@example.com", "This order is already attributed to buyer@example.com."],
    ["an over-long note", `email=friend@example.com&note=${"x".repeat(501)}`, "Keep the note under 500 characters."],
  ])("re-shows the form with an error for %s", async (_label, query, message) => {
    const res = await request(`/admin/orders/1001?${query}`);

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(message);
    expect(body).toContain('<form method="get" action="/admin/orders/1001">');
  });
});

describe("POST /admin/orders/:orderId/member", () => {
  it("attributes the order, records who did it, and shows both members' cards", async () => {
    await refreshMemberFromOrders(env, "buyer@example.com", { firstName: "Buy", lastName: "Er" });

    const res = await post("/admin/orders/1001/member", { email: " Friend@Example.com ", note: " gift " });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/orders/1001?attributed_from=buyer%40example.com");
    expect(await memberEmailOf("1001")).toBe("friend@example.com");
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
    await post("/admin/orders/1001/member", { email: "friend@example.com", note: "   " });

    expect(await env.DB.prepare("SELECT note FROM membership_order_attributions").first()).toEqual({ note: null });
  });

  it("refuses an invalid attribution without changing anything", async () => {
    const res = await post("/admin/orders/1001/member", { email: "buyer@example.com" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already attributed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM membership_order_attributions").first()).toEqual({ n: 0 });
  });

  it("refuses a submission missing its fields", async () => {
    const res = await post("/admin/orders/1001/member", {});

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter a valid email address.");
  });

  it("404s for an unknown order", async () => {
    expect((await post("/admin/orders/nope/member", { email: "friend@example.com" })).status).toBe(404);
  });
});

describe("emailing the new member their card", () => {
  // Everything the card image and Apple pass need, as in email-card.spec.ts.
  beforeEach(async () => {
    const chain = getTestCertChain();
    // Stated, not inherited: wrangler.toml sets this per environment, and
    // a test about delivery must not turn on what that happens to say today.
    env.EMAIL_RECIPIENT_ALLOWLIST = "*";
    email = fakeEmailBinding();
    env.EMAIL = email;
    env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
    env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
    env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
    env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
    env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
    env.PUBLIC_BASE_URL = ORIGIN;
    env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
    for (const key of ["templates/apple/icon.png", "templates/apple/icon@2x.png", "templates/apple/logo.png", "templates/apple/logo@2x.png", "templates/card/crest.png"]) {
      await env.ASSETS.put(key, new Uint8Array(LOGO));
    }
  });

  afterEach(() => {
    env.EMAIL = undefined;
  });

  it("sends the card once, only to the new member", async () => {
    forbidFetch();

    await post("/admin/orders/1001/member", { email: "friend@example.com", email_card: "on" });

    expect(sentTo()).toEqual(["friend@example.com"]);
  });

  it("says so on the page afterwards", async () => {
    forbidFetch();

    const res = await post("/admin/orders/1001/member", { email: "friend@example.com", email_card: "on" });
    const body = await (await request(res.headers.get("Location")!)).text();

    expect(body).toContain("Their card is on its way by email.");
  });

  it("sends nothing when the box is unchecked", async () => {
    forbidFetch();

    const res = await post("/admin/orders/1001/member", { email: "friend@example.com" });
    const body = await (await request(res.headers.get("Location")!)).text();

    expect(sentTo()).toEqual([]);
    expect(body).not.toContain("on its way by email");
  });

  it("sends nothing when the order gives the new member no card", async () => {
    await env.DB.exec("UPDATE membership_orders SET status = 'Refunded' WHERE order_id = '1001'");
    forbidFetch();

    await post("/admin/orders/1001/member", { email: "friend@example.com", email_card: "on" });

    expect(sentTo()).toEqual([]);
  });

  it("warns, and still attributes, when email isn't configured", async () => {
    env.EMAIL = undefined;
    forbidFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await post("/admin/orders/1001/member", { email: "friend@example.com", email_card: "on" });

    expect(sentTo()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Card email: the EMAIL binding is not configured, not sending");
    expect(await memberEmailOf("1001")).toBe("friend@example.com");
  });

  it("logs, and still attributes, when the binding rejects the message", async () => {
    env.EMAIL = fakeEmailBinding({ failWith: "domain not onboarded" });
    forbidFetch();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await post("/admin/orders/1001/member", { email: "friend@example.com", email_card: "on" });

    expect(error).toHaveBeenCalledWith("Card email failed", { reason: "attribution", error: expect.stringContaining("Cloudflare Email Service") });
    expect(await memberEmailOf("1001")).toBe("friend@example.com");
  });
});

describe("POST /admin/orders/:orderId/reread", () => {
  /** BigCommerce's copy of the seeded order 1001, with `overrides`. */
  function storeOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: 1001,
      customer_id: 42,
      status: "Completed",
      date_created: "2098-01-15T00:00:00.000Z",
      date_modified: "2098-01-15T00:00:00.000Z",
      billing_address: { first_name: "Buy", last_name: "Er", email: "buyer@example.com" },
      ...overrides,
    };
  }

  const MEMBERSHIP = [{ id: 1, product_id: 100, sku: "LOSV-MEM-0001", name: "Los Verdes Annual Membership", quantity: 1 }];

  /** Answers the two calls a re-read makes; anything else fails the test. */
  function mockStore(order: object | null, products: object[] = MEMBERSHIP) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/orders/1001/products")) return new Response(JSON.stringify(products), { status: 200 });
      if (url.endsWith("/orders/1001")) {
        return order === null ? new Response("", { status: 404 }) : new Response(JSON.stringify(order), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  beforeEach(() => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  function reread(from: "order" | "member" = "order") {
    return post("/admin/orders/1001/reread", { from });
  }

  async function statusOf(orderId: string) {
    return (await env.DB.prepare("SELECT status FROM membership_orders WHERE order_id = ?").bind(orderId).first<{ status: string }>())?.status;
  }

  it("applies what the store now says, and says it changed", async () => {
    mockStore(storeOrder({ status: "Refunded" }));

    const res = await reread();

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/orders/1001?reread=updated");
    expect(await statusOf("1001")).toBe("Refunded");
    expect(await (await request("/admin/orders/1001?reread=updated")).text()).toContain("It had changed");
  });

  it("says so when nothing had changed", async () => {
    mockStore(storeOrder());
    // The fixture row lacks what a sync records (SKU, membership count); the
    // first read fills those in, as the sync that recorded a real order did.
    await reread();

    expect((await reread()).headers.get("Location")).toBe("/admin/orders/1001?reread=unchanged");
  });

  it("flags an order the store no longer returns, and leaves it counting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStore(null);

    expect((await reread()).headers.get("Location")).toBe("/admin/orders/1001?reread=missing");
    const row = await env.DB.prepare("SELECT missing_since, status FROM membership_orders WHERE order_id = '1001'").first<{ missing_since: number | null; status: string }>();
    expect(row?.missing_since).not.toBeNull();
    expect(row?.status).toBe("Completed");
  });

  it("changes nothing when the store's copy carries no membership", async () => {
    mockStore(storeOrder({ status: "Refunded" }), [{ id: 1, product_id: 7, sku: "SCARF", name: "Scarf", quantity: 1 }]);

    expect((await reread()).headers.get("Location")).toBe("/admin/orders/1001?reread=no-membership");
    expect(await statusOf("1001")).toBe("Completed");
  });

  it("reports a store it could not reach, rather than failing the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));

    expect((await reread()).headers.get("Location")).toBe("/admin/orders/1001?reread=unreachable");
    expect(await statusOf("1001")).toBe("Completed");
  });

  it("never emails a card, even where a new order's webhook would be allowed to", async () => {
    // Every other guard open: any address may be emailed, and every order
    // date qualifies. Re-reading still stops short of the email step.
    env.EMAIL_RECIPIENT_ALLOWLIST = "*";
    env.CARD_EMAIL_NEW_ORDERS_SINCE = "2000-01-01";
    email = fakeEmailBinding();
    env.EMAIL = email;
    try {
      mockStore(storeOrder());

      await reread();

      expect(sentTo()).toEqual([]);
    } finally {
      env.EMAIL = undefined;
      env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
    }
  });

  it("goes back to the member page when pressed there, with the result", async () => {
    mockStore(storeOrder());
    await reread();

    const res = await reread("member");

    expect(res.headers.get("Location")).toBe("/admin/members?q=buyer%40example.com&reread=unchanged&order=1001");
  });

  it("offers the button on the member page for BigCommerce orders only", async () => {
    await insertOrder({ id: "5f00000000000000000000a9", email: "buyer@example.com", source: "squarespace", created: "2020-01-15T00:00:00Z" });
    await refreshMemberFromOrders(env, "buyer@example.com", { firstName: "Buy", lastName: "Er" });

    const body = await (await request("/admin/members?q=buyer%40example.com&reread=unchanged&order=1001")).text();

    expect(body).toContain('action="/admin/orders/1001/reread"');
    expect(body).not.toContain('action="/admin/orders/5f00000000000000000000a9/reread"');
    expect(body).toContain("Order 1001: Re-read from BigCommerce. Nothing had changed.");
  });

  it("refuses a Squarespace-era order, which has no store to re-read", async () => {
    await insertOrder({ id: "5f00000000000000000000b9", email: "old@example.com", source: "squarespace", created: "2020-01-15T00:00:00Z" });
    forbidFetch();

    expect((await post("/admin/orders/5f00000000000000000000b9/reread", {})).status).toBe(400);
  });

  it("is for admins only, and same-site only", async () => {
    const fetchSpy = forbidFetch();

    expect((await post("/admin/orders/1001/reread", {}, { as: MEMBER_ID })).status).toBe(403);
    expect((await post("/admin/orders/1001/reread", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a 404 for an order we do not hold", async () => {
    forbidFetch();

    expect((await post("/admin/orders/9999/reread", {})).status).toBe(404);
  });
});

describe("the order page", () => {
  it("shows how many memberships an over-full order carried", async () => {
    await env.DB.exec("UPDATE membership_orders SET membership_units = 3 WHERE order_id = '1001'");

    const body = await (await request("/admin/orders/1001")).text();

    expect(body).toMatch(/<th[^>]*>Memberships<\/th><td[^>]*>Carried 3 memberships; only this one was recorded\./);
  });
});
