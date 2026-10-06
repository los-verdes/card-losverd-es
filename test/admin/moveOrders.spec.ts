import "../setup/d1";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAttributions } from "../../src/admin/attribution";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { refreshMemberFromOrders } from "../../src/bigcommerce/sync";
import worker from "../../src/index";
import { getTestCertChain } from "../fixtures/certChain";
import { fakeEmailBinding, recipientOf, type FakeEmailBinding } from "../fixtures/emailBinding";
import { insertOrder } from "./fixtures";

const ORIGIN = "https://card.losverd.es";
const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;
const OLD = "old@example.com";
const NEW = "new@example.com";
const NOW = "2026-10-01T12:00:00Z";

async function request(path: string, init: RequestInit & { as?: number | null } = {}) {
  const { as = ADMIN_ID, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (as !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: as, isAdmin: as === ADMIN_ID });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function post(fields: [string, string][], options: { origin?: string; as?: number } = {}) {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Origin: options.origin ?? ORIGIN });
  return request("/admin/move-orders", { method: "POST", headers, body: new URLSearchParams(fields).toString(), as: options.as });
}

/** The confirm form's fields, as the review page renders them for `ids`. */
function confirmFields(ids: string[], extra: [string, string][] = []): [string, string][] {
  return [["from", OLD], ["to", NEW], ["note", "address they no longer use"], ...ids.map((id): [string, string] => ["order", id]), ...extra];
}

async function memberEmailOf(orderId: string) {
  return (await env.DB.prepare("SELECT member_email FROM membership_orders WHERE order_id = ?").bind(orderId).first<{ member_email: string }>())
    ?.member_email;
}

let email: FakeEmailBinding;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'member@example.com', 0)").bind(MEMBER_ID).run();
  await insertOrder({ id: "1001", email: OLD, created: "2024-03-01T00:00:00Z", status: "Refunded" });
  await insertOrder({ id: "1002", email: OLD, created: "2025-03-01T00:00:00Z" });
  await insertOrder({ id: "1003", email: OLD, created: "2026-03-01T00:00:00Z" });
  await refreshMemberFromOrders(env, OLD, { firstName: "Test", lastName: "Member" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  env.EMAIL = undefined;
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("access", () => {
  it("is for admins only, for viewing and moving alike", async () => {
    expect((await request(`/admin/move-orders?from=${OLD}`, { as: MEMBER_ID })).status).toBe(403);
    expect((await post(confirmFields(["1001"]), { as: MEMBER_ID })).status).toBe(403);
    expect(await memberEmailOf("1001")).toBe(OLD);
  });

  it("rejects a cross-site POST", async () => {
    expect((await post(confirmFields(["1001"]), { origin: "https://evil.example" })).status).toBe(403);
    expect(await memberEmailOf("1001")).toBe(OLD);
  });
});

describe("the member page", () => {
  it("links to moving every order when an address has more than one", async () => {
    const body = await (await request(`/admin/members?q=${OLD}`)).text();

    expect(body).toContain('<a href="/admin/move-orders?from=old%40example.com">Move all 3 orders to another address</a>');
  });

  it("does not, for an address with one order", async () => {
    await insertOrder({ id: "2001", email: "single@example.com", created: "2026-03-01T00:00:00Z" });
    await refreshMemberFromOrders(env, "single@example.com", { firstName: "Test", lastName: "Member" });

    expect(await (await request("/admin/members?q=single@example.com")).text()).not.toContain("/admin/move-orders");
  });

  it("links from an address with orders and no membership too", async () => {
    await insertOrder({ id: "3001", email: "lapsed@example.com", created: "2020-03-01T00:00:00Z", status: "Refunded" });
    await insertOrder({ id: "3002", email: "lapsed@example.com", created: "2021-03-01T00:00:00Z", status: "Refunded" });

    expect(await (await request("/admin/members?q=lapsed@example.com")).text()).toContain(
      "/admin/move-orders?from=lapsed%40example.com",
    );
  });
});

describe("GET /admin/move-orders", () => {
  it("lists the address's orders and asks where to move them, uncached", async () => {
    const res = await request(`/admin/move-orders?from=${OLD}`);
    const body = await res.text();

    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("Move every order from old@example.com");
    for (const id of ["1001", "1002", "1003"]) expect(body).toContain(`href="/admin/orders/${id}"`);
    expect(body).toContain('<input id="move_to" type="email" name="to" required');
  });

  it("reviews the move with where the new address already appears, carrying exactly the listed orders", async () => {
    const body = await (await request(`/admin/move-orders?from=${OLD}&to=${encodeURIComponent(" New@Example.com ")}&note=moved`)).text();

    expect(body).toContain("Move these 3 order(s):");
    expect(body).toContain("<strong>new@example.com</strong>");
    expect(body).toContain("Note: moved");
    expect(body.match(/name="order" value="\d+"/g)).toEqual([
      'name="order" value="1003"',
      'name="order" value="1002"',
      'name="order" value="1001"',
    ]);
  });

  it.each([
    ["not-an-address", "Enter a valid email address."],
    [OLD, "These orders are already attributed to old@example.com."],
  ])("refuses to review a move to %s", async (to, message) => {
    const res = await request(`/admin/move-orders?from=${OLD}&to=${encodeURIComponent(to)}`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
  });

  it("refuses an overlong note", async () => {
    const res = await request(`/admin/move-orders?from=${OLD}&to=${NEW}&note=${"x".repeat(501)}`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Keep the note under 500 characters.");
  });

  it("says so for an address with no orders", async () => {
    expect(await (await request("/admin/move-orders?from=nobody@example.com")).text()).toContain(
      "No orders are attributed to this address.",
    );
  });

  it("points back to the member page without an address to start from", async () => {
    const res = await request("/admin/move-orders");

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Start from a member&#39;s page");
  });

  it("says when none of the orders counts, so no card will be emailed", async () => {
    await insertOrder({ id: "4001", email: "void@example.com", created: "2026-03-01T00:00:00Z", status: "Refunded" });

    expect(await (await request(`/admin/move-orders?from=void@example.com&to=${NEW}`)).text()).toContain(
      "nothing will be sent: none of these counts as a membership",
    );
  });
});

describe("POST /admin/move-orders", () => {
  it("moves every listed order, each with its own history, and rebuilds both cards", async () => {
    const res = await post(confirmFields(["1001", "1002", "1003"]));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/move-orders?from=old%40example.com&moved_to=new%40example.com&count=3");
    for (const id of ["1001", "1002", "1003"]) {
      expect(await memberEmailOf(id)).toBe(NEW);
      expect(await listAttributions(env.DB, id)).toMatchObject([
        { previous_member_email: OLD, member_email: NEW, admin_email: "admin@example.com", note: "address they no longer use" },
      ]);
    }
    const cards = await env.DB.prepare("SELECT email, expiration_date FROM members ORDER BY email").all();
    expect(cards.results).toEqual([
      { email: NEW, expiration_date: "2027-03-01" },
      { email: OLD, expiration_date: null },
    ]);
    const audit = await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'order.reattributed' ORDER BY id").all();
    expect(audit.results.map((row) => row.detail)).toEqual([
      "Order 1003 moved from old@example.com -- address they no longer use",
      "Order 1002 moved from old@example.com -- address they no longer use",
      "Order 1001 moved from old@example.com -- address they no longer use",
    ]);

    const page = await (await request(res.headers.get("Location")!)).text();
    expect(page).toContain("Moved 3 order(s) from old@example.com to <strong>new@example.com</strong>.");
    expect(page).not.toContain("on its way by email");
  });

  it("leaves alone an order the review did not list, such as one that arrived since", async () => {
    await post(confirmFields(["1001", "1002"]));

    expect(await memberEmailOf("1003")).toBe(OLD);
  });

  it("goes back with an error when none of the listed orders is still the address's", async () => {
    await insertOrder({ id: "5001", email: "someone@example.com", created: "2026-03-01T00:00:00Z" });

    const res = await post(confirmFields(["5001"]));

    expect(res.headers.get("Location")).toContain("error=None+of+those+orders");
    expect(await memberEmailOf("5001")).toBe("someone@example.com");
  });

  it("refuses an invalid move outright", async () => {
    const res = await post([["from", OLD], ["to", OLD], ["order", "1001"]]);

    expect(res.status).toBe(400);
    expect(await memberEmailOf("1001")).toBe(OLD);
  });

  it("warns, sends nothing, and says so afterwards for an address this environment won't email", async () => {
    env.EMAIL_RECIPIENT_ALLOWLIST = "losverd.es";
    try {
      const review = await (await request(`/admin/move-orders?from=${OLD}&to=${NEW}`)).text();
      expect(review).toContain("This environment only sends email to losverd.es (EMAIL_RECIPIENT_ALLOWLIST)");

      const res = await post(confirmFields(["1001", "1002", "1003"], [["email_card", "on"]]));
      const page = await (await request(res.headers.get("Location")!)).text();

      expect(res.headers.get("Location")).toContain("&not_emailed=1");
      expect(page).toContain("Their card was not emailed. This environment only sends email to losverd.es");
      expect(page).not.toContain("on its way by email");
    } finally {
      env.EMAIL_RECIPIENT_ALLOWLIST = "*";
    }
  });

  it("emails the new member their card once when asked", async () => {
    const chain = getTestCertChain();
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
    });

    const res = await post(confirmFields(["1001", "1002", "1003"], [["email_card", "on"]]));

    expect(email.sent.map(recipientOf)).toEqual([NEW]);
    expect(res.headers.get("Location")).toContain("&emailed=1");
    expect(await (await request(res.headers.get("Location")!)).text()).toContain("Their card is on its way by email.");
  });
});
