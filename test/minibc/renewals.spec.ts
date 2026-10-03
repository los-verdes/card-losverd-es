import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { allRenewals, lastRenewalsRead, renewalState, renewalText, renewalsForMember } from "../../src/minibc/renewals";

async function insertOrder(o: {
  id: string;
  orderEmail: string;
  memberEmail?: string;
  customerId?: number | null;
  created?: string;
  subscriptionId?: number | null;
}) {
  const created = o.created ?? "2026-02-14T00:00:00Z";
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, customer_id, status, created_on, expires_on, first_seen_via, minibc_subscription_id)
     VALUES (?, 'bigcommerce', ?, ?, ?, 'Completed', ?, ?, 'sync', ?)`,
  )
    .bind(o.id, o.orderEmail, o.memberEmail ?? o.orderEmail, o.customerId ?? null, created, created, o.subscriptionId ?? null)
    .run();
}

async function insertMember(id: string, email: string, expiration: string | null) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at)
     VALUES (?, 'Test', 'Member', ?, ?, 'token', 1)`,
  )
    .bind(id, email, expiration)
    .run();
}

async function insertSubscription(s: {
  id: number;
  orderId?: number | null;
  originOrderId?: number | null;
  customerId?: number | null;
  status?: string;
  next?: string | null;
  missing?: boolean;
  email?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO minibc_subscriptions (subscription_id, order_id, origin_order_id, store_customer_id, sku, status, signup_on, next_payment_on, seen_at, missing_since, customer_email)
     VALUES (?, ?, ?, ?, 'LOSV-MEM-0001', ?, '2026-02-14', ?, 1, ?, ?)`,
  )
    .bind(s.id, s.orderId ?? null, s.originOrderId ?? null, s.customerId ?? null, s.status ?? "active", s.next === undefined ? "2027-02-14" : s.next, s.missing ? 5 : null, s.email ?? null)
    .run();
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM minibc_subscriptions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM etl_sync_state");
});

describe("matching a subscription to its member", () => {
  it("goes through the order that started it, following that order's attribution", async () => {
    await insertOrder({ id: "1001", orderEmail: "buyer@example.com", memberEmail: "recipient@example.com" });
    await insertSubscription({ id: 1, orderId: 1001 });

    expect((await allRenewals(env))[0].member_email).toBe("recipient@example.com");
  });

  it("prefers the latest order carrying its id, then the one that started it, then MiniBC's origin order", async () => {
    await insertOrder({ id: "1001", orderEmail: "first@example.com" });
    await insertOrder({ id: "2002", orderEmail: "renewed@example.com", subscriptionId: 1, created: "2027-02-14T00:00:00Z" });
    await insertOrder({ id: "3003", orderEmail: "origin@example.com" });
    await insertSubscription({ id: 1, orderId: 1001 });
    await insertSubscription({ id: 2, orderId: 9999, originOrderId: 3003 });

    const byId = Object.fromEntries((await allRenewals(env)).map((row) => [row.subscription_id, row.member_email]));
    expect(byId).toEqual({ 1: "renewed@example.com", 2: "origin@example.com" });
  });

  it("falls back to the store customer's own membership orders, never one they bought for somebody else", async () => {
    await insertOrder({ id: "1001", orderEmail: "buyer@example.com", memberEmail: "recipient@example.com", customerId: 77 });
    await insertSubscription({ id: 1, orderId: 9999, customerId: 77 });
    expect((await allRenewals(env))[0].member_email).toBeNull();

    await insertOrder({ id: "1002", orderEmail: "buyer@example.com", customerId: 77, created: "2026-03-01T00:00:00Z" });
    expect((await allRenewals(env))[0].member_email).toBe("buyer@example.com");
  });

  it("hints at the member whose address is MiniBC's email only when no order matches, and never matches by it", async () => {
    await insertMember("BC-1", "jane@example.com", "2027-02-14");
    await insertMember("BC-2", "pat@example.com", "2026-12-01");
    await insertOrder({ id: "1001", orderEmail: "pat@example.com" });
    // A guest checkout whose starting order is not held: only the address points anywhere.
    await insertSubscription({ id: 1, orderId: 999, email: "jane@example.com" });
    // An order matches this one, so the address (somebody else's) is no hint at all.
    await insertSubscription({ id: 2, orderId: 1001, email: "jane@example.com" });
    // An address no member has.
    await insertSubscription({ id: 3, orderId: 998, email: "nobody@example.com" });

    const rows = new Map((await allRenewals(env)).map((row) => [row.subscription_id, row]));
    expect(rows.get(1)).toMatchObject({ member_email: null, member_id: null, address_member_email: "jane@example.com", address_expiration_date: "2027-02-14" });
    expect(rows.get(2)).toMatchObject({ member_email: "pat@example.com", address_member_email: null });
    expect(rows.get(3)).toMatchObject({ member_email: null, address_member_email: null });

    // The member's own list has theirs first, then the one only their address points to.
    await insertOrder({ id: "1002", orderEmail: "jane@example.com" });
    await insertSubscription({ id: 4, orderId: 1002 });
    expect((await renewalsForMember(env, "jane@example.com")).map((row) => [row.subscription_id, row.member_email])).toEqual([
      [4, "jane@example.com"],
      [1, null],
    ]);
  });

  it("leaves out subscriptions MiniBC no longer lists", async () => {
    await insertSubscription({ id: 1, missing: true });
    expect(await allRenewals(env)).toEqual([]);
  });

  it("gives one member theirs, active first, with their card's date", async () => {
    await insertMember("BC-1", "jane@example.com", "2027-02-14");
    await insertOrder({ id: "1001", orderEmail: "jane@example.com" });
    await insertOrder({ id: "1002", orderEmail: "jane@example.com" });
    await insertOrder({ id: "1003", orderEmail: "other@example.com" });
    await insertSubscription({ id: 1, orderId: 1001, status: "inactive", next: null });
    await insertSubscription({ id: 2, orderId: 1002 });
    await insertSubscription({ id: 3, orderId: 1003 });

    const rows = await renewalsForMember(env, " Jane@Example.com ");
    expect(rows.map((row) => [row.subscription_id, row.status, row.member_id, row.expiration_date])).toEqual([
      [2, "active", "BC-1", "2027-02-14"],
      [1, "inactive", "BC-1", "2027-02-14"],
    ]);
  });

  it("says when MiniBC was last read", async () => {
    expect(await lastRenewalsRead(env)).toBeNull();
    await env.DB.prepare("INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES ('sync_minibc_subscriptions_etl', 1, 1234)").run();
    expect(await lastRenewalsRead(env)).toBe(1234);
  });
});

describe("what a subscription means for the card", () => {
  const TODAY = "2026-10-01";
  const active = (next: string | null) => ({ status: "active", next_payment_on: next, paused_on: null, cancelled_on: null });

  it("renews on time on the card's last day, or the day after, as in a year with 29 February", () => {
    expect(renewalState(active("2027-02-14"), "2027-02-14", TODAY)).toEqual({ kind: "renews", on: "2027-02-14" });
    expect(renewalState(active("2028-02-15"), "2028-02-14", TODAY)).toEqual({ kind: "renews", on: "2028-02-15" });
  });

  it("renews late once the next charge is further past the card's last day", () => {
    expect(renewalState(active("2027-03-14"), "2027-02-14", TODAY)).toEqual({ kind: "renews-late", on: "2027-03-14", cardEnds: "2027-02-14", daysAfter: 28 });
  });

  it("is overdue when the card has already run out, or there is no card or no next charge", () => {
    expect(renewalState(active("2026-11-01"), "2026-09-14", TODAY)).toEqual({ kind: "overdue", cardEnded: "2026-09-14", nextTry: "2026-11-01" });
    expect(renewalState(active("2026-11-01"), null, TODAY)).toEqual({ kind: "overdue", cardEnded: null, nextTry: "2026-11-01" });
    expect(renewalState(active(null), "2027-02-14", TODAY)).toEqual({ kind: "overdue", cardEnded: null, nextTry: null });
  });

  it("is paused or cancelled as MiniBC says, whatever the card", () => {
    expect(renewalState({ status: "paused", next_payment_on: null, paused_on: "2026-05-01", cancelled_on: null }, "2027-02-14", TODAY)).toEqual({ kind: "paused", since: "2026-05-01" });
    expect(renewalState({ status: "inactive", next_payment_on: null, paused_on: null, cancelled_on: "2026-06-01" }, "2027-02-14", TODAY)).toEqual({ kind: "cancelled", on: "2026-06-01" });
  });

  it.each([
    [{ kind: "renews", on: "2027-02-14" } as const, "Renews automatically on Feb 14, 2027"],
    [{ kind: "renews-late", on: "2027-03-14", cardEnds: "2027-02-14", daysAfter: 28 } as const, "Renews automatically on Mar 14, 2027, 28 days after the membership card runs out on Feb 14, 2027"],
    [{ kind: "overdue", cardEnded: "2026-09-14", nextTry: "2026-11-01" } as const, "Membership card ran out on Sep 14, 2026, but automatic renewal is still on: MiniBC's next payment is on Nov 1, 2026"],
    [{ kind: "overdue", cardEnded: null, nextTry: null } as const, "No current membership card, but automatic renewal is still on: MiniBC has no next payment date"],
    [{ kind: "paused", since: "2026-05-01" } as const, "Automatic renewal paused since May 1, 2026"],
    [{ kind: "paused", since: null } as const, "Automatic renewal paused"],
    [{ kind: "cancelled", on: "2026-06-01" } as const, "Automatic renewal cancelled on Jun 1, 2026"],
    [{ kind: "cancelled", on: null } as const, "Automatic renewal cancelled"],
  ])("says %j as %j", (state, text) => {
    expect(renewalText(state)).toBe(text);
  });
});
