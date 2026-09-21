import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncBigCommerceOrder, syncSubscriptionsEtl, type BigCommerceOrder, type BigCommerceOrderProduct } from "../../src/bigcommerce/sync";
import * as updates from "../../src/passkit/updates";
import { maybeEmailNewOrderCard } from "../../src/email/newOrder";
import { getTestCertChain } from "../fixtures/certChain";
import { fakeEmailBinding, recipientOf, type FakeEmailBinding } from "../fixtures/emailBinding";
import LOGO from "../fixtures/sample-logo.png";

const ORIGIN = "https://card.losverd.es";
const CUTOFF = "2026-09-01";

const PRODUCTS: BigCommerceOrderProduct[] = [
  { id: 1, product_id: 100, sku: "LOSV-MEM-0001", name: "Los Verdes Annual Membership" },
];

function makeOrder(overrides: Partial<BigCommerceOrder> = {}): BigCommerceOrder {
  return {
    id: 5001,
    customer_id: 42,
    status: "Completed",
    date_created: "2026-09-15T00:00:00.000Z",
    date_modified: "2026-09-15T00:00:00.000Z",
    billing_address: { first_name: "New", last_name: "Member", email: "new.member@example.com" },
    ...overrides,
  };
}

/** What the `send_email` binding was handed, per test. */
let email: FakeEmailBinding;

/**
 * Fakes BigCommerce; any other outbound fetch fails the test. Mail goes
 * through `env.EMAIL`, the fake binding, not over HTTP.
 */
function mockUpstreams(orders: BigCommerceOrder[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const listed = url.match(/\/v2\/orders\?/);
    if (listed) return Response.json(url.includes("min_id=0") ? orders : []);
    const match = url.match(/\/v2\/orders\/(\d+)(\/products)?$/);
    if (match) {
      const order = orders.find((o) => String(o.id) === match[1])!;
      return Response.json(match[2] ? PRODUCTS : order);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Who a binding was asked to email -- this test's, unless another is named. */
function sentTo(binding: FakeEmailBinding = email) {
  return binding.sent.map(recipientOf);
}

async function cardEmailRows() {
  return (await env.DB.prepare("SELECT order_id, member_email FROM card_emails").all()).results;
}

beforeEach(async () => {
  // Signs the unsubscribe link every card email carries.
  env.SESSION_SIGNING_KEY = "test-session-signing-key-0123456789";
  const chain = getTestCertChain();
  env.BIGCOMMERCE_ACCESS_TOKEN = "test-access-token";
  env.CARD_EMAIL_NEW_ORDERS_SINCE = CUTOFF;
  // Stated, not inherited: production leaves this empty until cutover, and
  // a test about delivery must not turn on what that happens to say today.
  env.EMAIL_RECIPIENT_ALLOWLIST = "*";
  email = fakeEmailBinding();
  env.EMAIL = email;
  env.PUBLIC_BASE_URL = ORIGIN;
  env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
  env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
  env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
  env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
  env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  for (const key of ["templates/apple/icon.png", "templates/apple/icon@2x.png", "templates/apple/logo.png", "templates/apple/logo@2x.png", "templates/card/crest.png"]) {
    await env.ASSETS.put(key, new Uint8Array(LOGO));
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
  env.EMAIL = undefined;
  await env.DB.exec("DELETE FROM card_emails");
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM etl_sync_state");
});

describe("a new order reaching Completed", () => {
  it("emails the member their card and records the send", async () => {
    const order = makeOrder();
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual(["new.member@example.com"]);
    expect(await cardEmailRows()).toEqual([{ order_id: "5001", member_email: "new.member@example.com" }]);
  });

  it("keeps a send the recipient unsubscribed from out of their history", async () => {
    // Nothing reached them, so "Card emailed" would be a false line in the
    // audit log -- and the order's one send is still spent, as it should be.
    env.EMAIL = fakeEmailBinding({ suppressed: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = makeOrder();
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);

    const { results } = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'card.emailed'").all();
    expect(results).toEqual([]);
    expect(await cardEmailRows()).toHaveLength(1);
  });

  it("says why the member is getting it", async () => {
    const order = makeOrder();
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);

    const [message] = email.sent;
    expect(message.text + message.html).toContain(
      "a Los Verdes membership was purchased for this address",
    );
  });

  it("sends nothing on a re-delivery of the same completed order", async () => {
    const order = makeOrder();
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);
    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual(["new.member@example.com"]);
  });

  it("waits for Completed: an order that arrives awaiting fulfillment emails only once it completes", async () => {
    const awaiting = makeOrder({ status: "Awaiting Fulfillment" });
    mockUpstreams([awaiting]);
    await syncBigCommerceOrder(env, "store123", awaiting.id);
    expect(sentTo()).toEqual([]);

    vi.restoreAllMocks();
    mockUpstreams([makeOrder()]);
    await syncBigCommerceOrder(env, "store123", awaiting.id);

    expect(sentTo()).toEqual(["new.member@example.com"]);
  });

  it("sends nothing for an order that never counts as a membership", async () => {
    const order = makeOrder({ status: "Refunded" });
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual([]);
    expect(await cardEmailRows()).toEqual([]);
  });
});

describe("the guards against mailing existing members", () => {
  it("sends nothing while CARD_EMAIL_NEW_ORDERS_SINCE is unset", async () => {
    env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
    const order = makeOrder();
    mockUpstreams([order]);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual([]);
    expect(await cardEmailRows()).toEqual([]);
  });

  it("sends nothing for an order created before the cutoff", async () => {
    const old = makeOrder({ date_created: "2026-08-31T23:59:59.000Z" });
    mockUpstreams([old]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await syncBigCommerceOrder(env, "store123", old.id);

    expect(sentTo()).toEqual([]);
    expect(info).toHaveBeenCalledWith("New-order card email: order predates CARD_EMAIL_NEW_ORDERS_SINCE, not sending", {
      orderId: old.id,
    });
  });

  // A var whose whole job is preventing a mass send must fail closed.
  it.each(["10/01/2026", "1", "2026-13-45"])("sends nothing when the cutoff is %s, and says so", async (value) => {
    env.CARD_EMAIL_NEW_ORDERS_SINCE = value;
    const order = makeOrder();
    mockUpstreams([order]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual([]);
    expect(await cardEmailRows()).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "New-order card email: CARD_EMAIL_NEW_ORDERS_SINCE is not a YYYY-MM-DD date, not sending",
      { value },
    );
  });

  // (The sync itself rejects such an order earlier, writing its history; this
  // is about the email never being the thing that fails a message.)
  it("sends nothing for an unreadable order date, without throwing", async () => {
    const order = makeOrder({ date_created: "not a date" });
    mockUpstreams([order]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(maybeEmailNewOrderCard(env, order, "new.member@example.com")).resolves.toBe(false);

    expect(sentTo()).toEqual([]);
    expect(error).toHaveBeenCalledWith("New-order card email: could not read the order's creation date, not sending", {
      orderId: order.id,
      dateCreated: "not a date",
    });
  });

  it("keeps the order's one chance when email isn't configured yet", async () => {
    env.EMAIL = undefined;
    const order = makeOrder();
    mockUpstreams([order]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(await cardEmailRows()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Card email: the EMAIL binding is not configured, not sending");

    // Configured later, the same order still gets its email.
    vi.restoreAllMocks();
    env.EMAIL = email;
    mockUpstreams([order]);
    await syncBigCommerceOrder(env, "store123", order.id);
    expect(sentTo()).toEqual(["new.member@example.com"]);
  });

  // The order synced, then something after the write threw and the queue
  // redelivered: D1 already says Completed, and the email must still go.
  it("still emails after a retry that follows a failure later in the sync", async () => {
    const order = makeOrder();
    mockUpstreams([order]);
    vi.spyOn(updates, "notifyPassUpdated").mockRejectedValueOnce(new Error("APNs blew up"));

    await expect(syncBigCommerceOrder(env, "store123", order.id)).rejects.toThrow("APNs blew up");
    expect(sentTo()).toEqual([]);

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(sentTo()).toEqual(["new.member@example.com"]);
  });

  // The backfill case: a full resync of completed orders must stay silent,
  // however recent those orders are.
  it("sends nothing from a full resync", async () => {
    const orders = [makeOrder(), makeOrder({ id: 5002, billing_address: { first_name: "Another", last_name: "Member", email: "another@example.com" } })];
    mockUpstreams(orders);

    const result = await syncSubscriptionsEtl(env, { loadAll: true });

    expect(result.ordersProcessed).toBe(2);
    expect(sentTo()).toEqual([]);
    expect(await cardEmailRows()).toEqual([]);
  });

  it("sends nothing from a scheduled incremental resync", async () => {
    mockUpstreams([makeOrder()]);

    await syncSubscriptionsEtl(env);

    expect(sentTo()).toEqual([]);
  });

  // Two deliveries of the same webhook arriving at once: both see no stored
  // status, and the claim decides which one sends.
  it("sends nothing when another delivery already claimed the order", async () => {
    const order = makeOrder();
    mockUpstreams([order]);
    await env.DB.prepare(
      "INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("5001", "bigcommerce", "new.member@example.com", "new.member@example.com", "Completed", "2026-09-15T00:00:00Z", "2027-09-15T00:00:00Z", "sync")
      .run();
    await env.DB.prepare("INSERT INTO card_emails (order_id, member_email) VALUES (?, ?)").bind("5001", "new.member@example.com").run();

    const sent = await maybeEmailNewOrderCard(env, order, "new.member@example.com");

    expect(sent).toBe(false);
    expect(sentTo()).toEqual([]);
  });

  it("records the send before trying it, so a failure can't become a second email", async () => {
    const order = makeOrder();
    const failing = fakeEmailBinding({ failWith: "domain not onboarded" });
    env.EMAIL = failing;
    mockUpstreams([order]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncBigCommerceOrder(env, "store123", order.id);

    expect(error).toHaveBeenCalledWith("Card email failed", { reason: "new-order", error: expect.stringContaining("Cloudflare Email Service") });
    expect(await cardEmailRows()).toHaveLength(1);
    // Attempted once, and rejected.
    expect(sentTo(failing)).toEqual(["new.member@example.com"]);

    // A working binding on the retry: the claim already stands, so nothing
    // goes out a second time.
    vi.restoreAllMocks();
    const retry = fakeEmailBinding();
    env.EMAIL = retry;
    mockUpstreams([order]);
    await syncBigCommerceOrder(env, "store123", order.id);
    expect(sentTo(retry)).toEqual([]);
  });
});
