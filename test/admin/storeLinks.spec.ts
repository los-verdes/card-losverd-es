import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { StoreCustomerLink, StoreOrderLink } from "../../src/admin/storeLinks";
import worker from "../../src/index";
import { insertOrder } from "./fixtures";

/**
 * Admin pages link an order, a customer or a subscription to the same thing
 * in BigCommerce's or MiniBC's own dashboard, so an admin needn't search for
 * it there by hand.
 */

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const STORE = "https://store-3nco2w7eup.mybigcommerce.com/manage";

async function get(path: string) {
  const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } }),
    env,
    createExecutionContext(),
  );
}

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
});

afterEach(async () => {
  env.BIGCOMMERCE_STORE_HASH = "3nco2w7eup";
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM users");
});

describe("the order page", () => {
  it("opens a BigCommerce order, and its customer, in the store's own control panel", async () => {
    await insertOrder({ id: "1001", email: "pat@example.com", created: "2026-01-15T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET customer_id = 5594").run();

    const body = await (await get("/admin/orders/1001")).text();

    expect(body).toContain(`<a href="${STORE}/orders/1001" target="_blank" rel="noopener noreferrer" title="This order in BigCommerce">Open in BigCommerce ↗</a>`);
    expect(body).toContain(`<a href="${STORE}/customers/5594/edit" target="_blank" rel="noopener noreferrer" title="This customer in BigCommerce">Customer 5594 ↗</a>`);
  });

  it("says a guest checkout has no customer to open", async () => {
    await insertOrder({ id: "1001", email: "pat@example.com", created: "2026-01-15T00:00:00Z" });
    await env.DB.prepare("UPDATE membership_orders SET customer_id = 0").run();

    expect(await (await get("/admin/orders/1001")).text()).toContain("a guest checkout");
  });

  it("offers nothing in BigCommerce for an order from the Squarespace years", async () => {
    await insertOrder({ id: "5f00000000000000000000c3", email: "pat@example.com", created: "2021-01-15T00:00:00Z", source: "squarespace" });

    const body = await (await get("/admin/orders/5f00000000000000000000c3")).text();

    expect(body).not.toContain("mybigcommerce.com");
    expect(body).not.toContain("Store customer");
  });

  it("links to the environment's own store, so staging's open the sandbox", async () => {
    env.BIGCOMMERCE_STORE_HASH = "kouyh8feen";
    await insertOrder({ id: "1001", email: "pat@example.com", created: "2026-01-15T00:00:00Z" });

    expect(await (await get("/admin/orders/1001")).text()).toContain('href="https://store-kouyh8feen.mybigcommerce.com/manage/orders/1001"');
  });
});

describe("outside a request, or without a usable store", () => {
  it("shows the id without a link rather than a broken one", async () => {
    expect(String((await StoreOrderLink({ orderId: "1001" })) ?? "")).toBe("");
    expect(String(await StoreCustomerLink({ customerId: 5594, children: "Customer 5594" }))).toBe("Customer 5594");
  });
});
