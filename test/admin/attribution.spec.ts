import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributeOrder,
  emailFootprint,
  getAttributableOrder,
  listAttributions,
} from "../../src/admin/attribution";
import { refreshMemberFromOrders } from "../../src/bigcommerce/sync";
import { emailMemberCard } from "../../src/email/card";
import { insertOrder, insertSlackUser } from "./fixtures";

const ADMIN_ID = 1;
const FALLBACK = { firstName: "Test", lastName: "Member", membershipTier: "standard" };

async function member(email: string) {
  return env.DB.prepare("SELECT member_id, first_name, last_name, membership_tier, status, expiration_date FROM members WHERE email = ?")
    .bind(email)
    .first<{ member_id: string; first_name: string; last_name: string; membership_tier: string; status: string; expiration_date: string | null }>();
}

async function order(id: string) {
  return (await getAttributableOrder(env.DB, id))!;
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // pass pushes skip without APNs secrets
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM slack_users");
  await env.DB.exec("DELETE FROM users");
});

describe("getAttributableOrder", () => {
  it("returns the order with whether it counts as a membership", async () => {
    await insertOrder({ id: "1_bc", email: "buyer@example.com", created: "2098-01-15T00:00:00Z" });
    await insertOrder({ id: "2_bc", email: "buyer@example.com", created: "2098-02-15T00:00:00Z", status: "Refunded" });

    expect(await getAttributableOrder(env.DB, "1_bc")).toMatchObject({ order_id: "1_bc", member_email: "buyer@example.com", counts: 1 });
    expect((await getAttributableOrder(env.DB, "2_bc"))?.counts).toBe(0);
    expect(await getAttributableOrder(env.DB, "nope")).toBeNull();
  });
});

describe("emailFootprint", () => {
  it("is empty for an address that appears nowhere", async () => {
    expect(await emailFootprint(env.DB, "nobody@example.com")).toEqual({
      member: null,
      memberOrders: { total: 0, counted: 0 },
      placedOrders: 0,
      login: null,
      slack: null,
    });
  });

  it("finds the address's card, orders, login, and Slack account", async () => {
    await insertOrder({ id: "1_bc", email: "someone@example.com", created: "2098-01-15T00:00:00Z" });
    await insertOrder({ id: "2_bc", email: "someone@example.com", created: "2097-01-15T00:00:00Z", status: "Cancelled" });
    await insertOrder({ id: "3_bc", email: "someone@example.com", memberEmail: "elsewhere@example.com", created: "2096-01-15T00:00:00Z" });
    await refreshMemberFromOrders(env, "someone@example.com", FALLBACK);
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (2, 'someone@example.com', 0)").run();
    await insertSlackUser({ id: "U2", email: "someone@example.com", realName: "Old Account", deleted: true });
    await insertSlackUser({ id: "U1", email: "Someone@Example.com", realName: "Some One" });

    const footprint = await emailFootprint(env.DB, "someone@example.com");

    expect(footprint).toMatchObject({
      member: { status: "active", expiration_date: "2099-01-15" },
      memberOrders: { total: 2, counted: 1 },
      placedOrders: 3,
      login: { is_admin: 0 },
      slack: { slack_id: "U1", deleted: 0 },
    });
  });
});

describe("attributeOrder", () => {
  it("moves a gifted order to its recipient, leaving the buyer their own membership", async () => {
    await insertOrder({ id: "1_bc", email: "buyer@example.com", first: "Buy", last: "Er", created: "2098-01-15T00:00:00Z" });
    await insertOrder({ id: "2_bc", email: "buyer@example.com", first: "Buy", last: "Er", created: "2098-06-15T00:00:00Z" });
    await refreshMemberFromOrders(env, "buyer@example.com", FALLBACK);
    const buyerBefore = await member("buyer@example.com");
    expect(buyerBefore?.expiration_date).toBe("2099-06-15");

    const result = await attributeOrder(env, await order("2_bc"), "gift.recipient@example.com", ADMIN_ID, "gift from the buyer");

    expect(result.previousMemberEmail).toBe("buyer@example.com");
    expect(result.previous).toEqual({ memberId: buyerBefore?.member_id, passChanged: true });
    expect(result.current?.passChanged).toBe(true);
    expect(await member("buyer@example.com")).toMatchObject({ member_id: buyerBefore?.member_id, expiration_date: "2099-01-15" });
    expect(await member("gift.recipient@example.com")).toMatchObject({
      member_id: result.current?.memberId,
      expiration_date: "2099-06-15",
      status: "active",
    });
    expect((await order("2_bc")).member_email).toBe("gift.recipient@example.com");
    expect(await listAttributions(env.DB, "2_bc")).toEqual([
      {
        previous_member_email: "buyer@example.com",
        member_email: "gift.recipient@example.com",
        admin_email: "admin@example.com",
        note: "gift from the buyer",
        created_at: expect.any(Number),
      },
    ]);
  });

  it("lists attribution history newest first", async () => {
    await insertOrder({ id: "1_bc", email: "buyer@example.com", created: "2098-01-15T00:00:00Z" });
    await attributeOrder(env, await order("1_bc"), "first@example.com", ADMIN_ID, null);
    await attributeOrder(env, await order("1_bc"), "second@example.com", ADMIN_ID, null);

    expect((await listAttributions(env.DB, "1_bc")).map((a) => a.member_email)).toEqual(["second@example.com", "first@example.com"]);
  });

  it("gives a new member the order's name and tier when their history has none, and skips a previous member with no card", async () => {
    await insertOrder({ id: "sq-1", email: "legacy@example.com", source: "squarespace", created: "2098-01-15T00:00:00Z" });
    await env.DB.exec("UPDATE membership_orders SET first_name = NULL, last_name = NULL, sku = NULL");

    const result = await attributeOrder(env, await order("sq-1"), "current.address@example.com", ADMIN_ID, null);

    expect(result.previous).toBeNull();
    expect(await member("current.address@example.com")).toMatchObject({ first_name: "", last_name: "", membership_tier: "standard" });
  });

  it("uses the order's tier for a known membership SKU", async () => {
    await insertOrder({ id: "1_bc", email: "buyer@example.com", created: "2098-01-15T00:00:00Z" });
    await env.DB.exec("UPDATE membership_orders SET sku = 'LOSV-MEM-0001', first_name = NULL");

    await attributeOrder(env, await order("1_bc"), "recipient@example.com", ADMIN_ID, null);

    expect((await member("recipient@example.com"))?.membership_tier).toBe("standard");
  });

  it("creates no card for the recipient of an order that doesn't count, and pushes nothing for an unchanged card", async () => {
    await insertOrder({ id: "1_bc", email: "recipient@example.com", created: "2098-01-15T00:00:00Z" });
    await refreshMemberFromOrders(env, "recipient@example.com", FALLBACK);
    await insertOrder({ id: "2_bc", email: "buyer@example.com", created: "2097-01-15T00:00:00Z", status: "Refunded" });

    const result = await attributeOrder(env, await order("2_bc"), "recipient@example.com", ADMIN_ID, null);

    expect(result.previous).toBeNull();
    expect(result.current?.passChanged).toBe(false);
    expect(await member("buyer@example.com")).toBeNull();
  });
});

describe("emailMemberCard", () => {
  // The route only calls this for a member it just gave a card, so these are
  // the belt-and-braces checks: nothing is emailed without a current card.
  beforeEach(() => {
    env.SENDGRID_API_KEY = "SG.test-key";
  });

  afterEach(() => {
    env.SENDGRID_API_KEY = undefined;
  });

  it("sends nothing for an address with no member row", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await emailMemberCard(env, "nobody@example.com", { kind: "attribution" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs, rather than throwing, when the member lookup itself fails", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 unavailable"); } } } as unknown as typeof env;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(emailMemberCard(broken, "someone@example.com", { kind: "attribution" })).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith("Card email failed", { reason: "attribution", error: expect.stringContaining("D1 unavailable") });
  });

  it("sends nothing for a member whose card isn't current", async () => {
    await insertOrder({ id: "1_bc", email: "lapsed@example.com", created: "2020-01-15T00:00:00Z" });
    await refreshMemberFromOrders(env, "lapsed@example.com", FALLBACK);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await emailMemberCard(env, "lapsed@example.com", { kind: "attribution" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
