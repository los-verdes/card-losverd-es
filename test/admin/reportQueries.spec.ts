import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeMemberships,
  consolidations,
  expiredMemberships,
  listChannels,
  ordersByDay,
  slackCrossReference,
  type MembershipOrderRow,
} from "../../src/admin/reportQueries";
import { insertCardName, insertMember, insertMemberSince, insertOrder, insertSlackUser } from "./fixtures";

const AS_OF = "2026-06-01T12:00:00Z";

beforeEach(async () => {
  // Current, and renewed early: two orders active at AS_OF, one member.
  await insertOrder({ id: "1", email: "renewer@example.com", first: "Rene", last: "Wer", created: "2025-07-01T00:00:00Z" });
  await insertOrder({ id: "2", email: "renewer@example.com", first: "Rene", last: "Wer", created: "2026-05-20T00:00:00Z", channel: "bigcommerce_iphone" });
  // Current, Squarespace-era style row with no status or channel.
  await insertOrder({ id: "5f00000000000000000000b2", source: "squarespace", email: "steady@example.com", created: "2025-09-09T00:00:00Z", status: null, channel: null });
  // Lapsed: last order expired 2025-03-01, an older one before it.
  await insertOrder({ id: "3", email: "lapsed@example.com", first: "Lap", last: "Sed", created: "2023-03-01T00:00:00Z" });
  await insertOrder({ id: "4", email: "lapsed@example.com", first: "Lap", last: "Sed", created: "2024-03-01T00:00:00Z" });
  // Old order under an old address, renewed under the new one: NOT lapsed.
  await insertOrder({ id: "5", email: "old.address@example.com", memberEmail: "moved@example.com", created: "2024-01-01T00:00:00Z" });
  await insertOrder({ id: "6", email: "moved@example.com", created: "2026-01-01T00:00:00Z" });
  // Never memberships: refunded, and cancelled in the Squarespace spelling.
  await insertOrder({ id: "7", email: "refunded@example.com", created: "2026-02-01T00:00:00Z", status: "Refunded" });
  await insertOrder({ id: "sq-void", source: "squarespace", email: "void@example.com", created: "2026-02-02T00:00:00Z", status: "CANCELED", counted: 0 });
  // Not yet placed at AS_OF.
  await insertOrder({ id: "8", email: "future@example.com", created: "2026-08-01T00:00:00Z" });
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("activeMemberships", () => {
  it("lists orders active at the instant, newest first, skipping voided ones", async () => {
    const result = await activeMemberships(env.DB, AS_OF);

    expect(result.rows.map((r) => r.order_id)).toEqual(["2", "6", "5f00000000000000000000b2", "1"]);
    expect(result.totalOrders).toBe(4);
    expect(result.totalMembers).toBe(3); // the early renewer counts once
  });

  it("answers for a past date: who was a member then", async () => {
    const result = await activeMemberships(env.DB, "2024-06-01T00:00:00Z");

    expect(result.rows.map((r) => r.order_id)).toEqual(["4", "5"]);
  });

  it("treats the expiry instant itself as no longer active", async () => {
    const lapsed = (rows: MembershipOrderRow[]) => rows.filter((r) => r.member_email === "lapsed@example.com");
    const atExpiry = await activeMemberships(env.DB, "2025-03-01T00:00:00Z");
    const justBefore = await activeMemberships(env.DB, "2025-02-28T23:59:59Z");

    expect(lapsed(atExpiry.rows)).toEqual([]);
    expect(lapsed(justBefore.rows).map((r) => r.order_id)).toEqual(["4"]);
  });

  it("filters by channel", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { channel: "bigcommerce_iphone" })).rows.map((r) => r.order_id)).toEqual(["2"]);
  });

  it("lists newest first, every row counted", async () => {
    const result = await activeMemberships(env.DB, AS_OF);

    expect(result.rows.slice(2).map((r) => r.order_id)).toEqual(["5f00000000000000000000b2", "1"]);
    expect(result.totalOrders).toBe(4);
  });
});

describe("expiredMemberships", () => {
  it("lists each lapsed member once, by their most recent order", async () => {
    const result = await expiredMemberships(env.DB, AS_OF);

    expect(result.rows.map((r) => r.order_id)).toEqual(["4"]);
    expect(result.rows[0]).toMatchObject({ member_email: "lapsed@example.com", expires_on: "2025-03-01T00:00:00Z" });
    expect(result.total).toBe(1);
  });

  it("doesn't list someone who renewed under a different address", async () => {
    const emails = (await expiredMemberships(env.DB, AS_OF)).rows.map((r) => r.member_email);

    expect(emails).not.toContain("moved@example.com");
  });

  it("ignores orders placed after the instant: a since-renewed member was lapsed back then", async () => {
    const result = await expiredMemberships(env.DB, "2025-06-01T00:00:00Z");

    expect(result.rows.map((r) => r.member_email).sort()).toEqual(["lapsed@example.com", "moved@example.com"]);
  });

  it("filters, and counts every lapsed member", async () => {
    const asOf = "2025-06-01T00:00:00Z";

    expect((await expiredMemberships(env.DB, asOf, { channel: "bigcommerce_iphone" })).total).toBe(0);
    const all = await expiredMemberships(env.DB, asOf);
    expect(all.rows).toHaveLength(2);
    expect(all.total).toBe(2);
  });
});

describe("ordersByDay", () => {
  it("counts real membership orders per day, oldest first, leaving out void ones", async () => {
    const days = await ordersByDay(env.DB);
    const inMonth = (month: string) =>
      days.filter((point) => point.day.startsWith(month)).reduce((sum, point) => sum + point.orders, 0);

    expect(days.map((point) => point.day)).toEqual([...days.map((point) => point.day)].sort());
    expect(inMonth("2026-01")).toBe(1);
    expect(inMonth("2026-02")).toBe(0); // all three February orders are void
    expect(inMonth("2026-05")).toBe(1);
    expect(inMonth("2025-07")).toBe(1);
    expect(inMonth("2026-08")).toBe(1);
    expect(inMonth("2025-09")).toBe(1);
  });
});

describe("slackCrossReference", () => {
  beforeEach(async () => {
    // Stored lowercased by the sync; mixed case here proves the join doesn't rely on it.
    await insertSlackUser({ id: "U01RENEWER", email: "Renewer@Example.com", realName: "Rene Wer" });
    await insertSlackUser({ id: "U02LAPSED", email: "lapsed@example.com" }); // no real name: falls back to the handle
    await insertSlackUser({ id: "U03REFUND", email: "refunded@example.com", syncedAt: Date.UTC(2026, 5, 1, 6) });
    await insertSlackUser({ id: "U04NEWBIE", email: "newbie@example.com", realName: "New Bee" });
    await insertSlackUser({ id: "U05FUTURE", email: "future@example.com" });
    // Matches only an order email, not the member it now belongs to.
    await insertSlackUser({ id: "U06OLDADDR", email: "old.address@example.com" });
    // Never counted as being in Slack.
    await insertSlackUser({ id: "U07GONE", email: "steady@example.com", deleted: true });
    await insertSlackUser({ id: "U08BOT", email: null, isBot: true });
    await insertSlackUser({ id: "U09APP", email: "app@example.com", isAppUser: true });
    await insertSlackUser({ id: "U10FLOW", email: "flow@example.com", isWorkflowBot: true });
    await insertSlackUser({ id: "USLACKBOT", email: null, realName: "Slackbot" });
  });

  afterEach(async () => {
    await env.DB.exec("DELETE FROM slack_users");
  });

  it("sorts members and Slack accounts into the four tables", async () => {
    const result = await slackCrossReference(env.DB, AS_OF);

    expect(result.currentInSlack).toEqual([
      { email: "renewer@example.com", first_name: "Rene", last_name: "Wer", expires_on: "2027-05-20T00:00:00Z", slack_id: "U01RENEWER", slack_name: "Rene Wer" },
    ]);
    expect(result.currentNotInSlack).toEqual([
      { email: "moved@example.com", first_name: "Test", last_name: "Member", expires_on: "2027-01-01T00:00:00Z", slack_id: null, slack_name: null },
      { email: "steady@example.com", first_name: "Test", last_name: "Member", expires_on: "2026-09-09T00:00:00Z", slack_id: null, slack_name: null },
    ]);
    expect(result.lapsedInSlack).toEqual([
      { email: "lapsed@example.com", first_name: "Lap", last_name: "Sed", expires_on: "2025-03-01T00:00:00Z", slack_id: "U02LAPSED", slack_name: "u02lapsed" },
    ]);
    // Void, test, and not-yet-placed orders don't count; nor does a bare order email.
    expect(result.slackWithoutOrders).toEqual(
      ["future", "newbie", "old.address", "refunded"].map((who) => expect.objectContaining({ email: `${who}@example.com`, expires_on: null })),
    );
    expect(result.slackWithoutOrders[1]).toMatchObject({ slack_id: "U04NEWBIE", slack_name: "New Bee", first_name: null });
    expect(result.slackSyncedAt).toBe(Date.UTC(2026, 5, 1, 6));
  });

  it("answers for a past date against the same Slack accounts", async () => {
    const result = await slackCrossReference(env.DB, "2024-06-01T00:00:00Z");

    expect(result.currentInSlack.map((r) => r.email)).toEqual(["lapsed@example.com"]);
    expect(result.currentNotInSlack.map((r) => r.email)).toEqual(["moved@example.com"]);
    expect(result.lapsedInSlack).toEqual([]);
    expect(result.slackWithoutOrders.map((r) => r.email)).toContain("renewer@example.com");
  });

  it("reports an unsynced workspace as nobody in Slack", async () => {
    await env.DB.exec("DELETE FROM slack_users");

    const result = await slackCrossReference(env.DB, AS_OF);

    expect(result.slackSyncedAt).toBeNull();
    expect(result.currentNotInSlack.map((r) => r.email)).toEqual(["moved@example.com", "renewer@example.com", "steady@example.com"]);
    expect(result.currentInSlack.concat(result.lapsedInSlack, result.slackWithoutOrders)).toEqual([]);
  });
});

describe("listChannels", () => {
  it("lists distinct non-null channels alphabetically", async () => {
    expect(await listChannels(env.DB)).toEqual(["bigcommerce_iphone", "bigcommerce_www"]);
  });
});

describe("consolidations", () => {
  // These tests describe the whole table, so start from an empty one.
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM membership_orders");
  });

  it("lists orders attributed elsewhere, newest change first, and says which came from the legacy import", async () => {
    await insertOrder({ id: "1", email: "buyer@example.com", memberEmail: "recipient@example.com", first: "Buy", last: "Er", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "2", email: "moved.away@example.com", memberEmail: "moved.here@example.com", created: "2026-02-15T00:00:00Z" });
    await insertOrder({ id: "3", email: "plain@example.com", created: "2026-03-15T00:00:00Z" });
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, 'boss@example.com', 1)").run();
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, admin_user_id, note, created_at)
       VALUES ('1', 'buyer@example.com', 'recipient@example.com', 9, 'gift', 1700000000000)`,
    ).run();

    const { attributed } = await consolidations(env.DB);

    expect(attributed).toEqual([
      expect.objectContaining({
        order_id: "1",
        order_email: "buyer@example.com",
        member_email: "recipient@example.com",
        attributed_at: 1700000000000,
        attributed_by: "boss@example.com",
        note: "gift",
      }),
      expect.objectContaining({ order_id: "2", attributed_at: null, attributed_by: null, note: null }),
    ]);
  });

  it("reports only the latest change for an order", async () => {
    await insertOrder({ id: "1", email: "buyer@example.com", memberEmail: "second@example.com", created: "2026-01-15T00:00:00Z" });
    for (const [to, at] of [["first@example.com", 1], ["second@example.com", 2]] as const) {
      await env.DB.prepare(
        `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email, note, created_at) VALUES ('1', 'buyer@example.com', ?, ?, ?)`,
      )
        .bind(to, `change ${at}`, at)
        .run();
    }

    const { attributed } = await consolidations(env.DB);

    expect(attributed).toHaveLength(1);
    expect(attributed[0].note).toBe("change 2");
  });

  it("lists card names set by hand beside the name the orders give, and links the order it comes from", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, 'boss@example.com', 1)").run();
    await insertOrder({ id: "1", email: "pat@example.com", first: "Patricia", last: "Lee", created: "2024-01-15T00:00:00Z" });
    await insertOrder({ id: "2", email: "pat@example.com", first: "Pat", last: "Lee", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "3", email: "pat@example.com", first: "Wrong", last: "Name", created: "2026-02-15T00:00:00Z", status: "Refunded" });
    await insertMember({ id: "LV-1", email: "pat@example.com", first: "Pat", last: "Lee", memberSince: "2024-01-15" });
    await insertMember({ id: "LV-2", email: "sam@example.com", first: "Sam", last: "Ray", memberSince: "2025-05-01" });
    await insertCardName({ email: "pat@example.com", name: "P. Lee", source: "admin", setBy: 9, note: "asked by email", at: 3000 });
    await insertCardName({ email: "sam@example.com", name: " sam ray ", source: "member", at: 2000 });
    await insertCardName({ email: "gone@example.com", name: "Old Name", source: "legacy_postgres", at: 1000 });

    const { cardNames } = await consolidations(env.DB);

    expect(cardNames).toEqual([
      {
        member_email: "pat@example.com", display_name: "P. Lee", order_name: "Pat Lee", same_as_orders: 0,
        source: "admin", set_by: "boss@example.com", set_at: 3000, note: "asked by email",
        // The latest counted order; the refunded one after it names nobody.
        order_id: "2",
      },
      expect.objectContaining({ member_email: "sam@example.com", same_as_orders: 1, source: "member", set_by: null, order_id: null }),
      // Carried over from the previous site for an address with no card here.
      expect.objectContaining({ member_email: "gone@example.com", order_name: null, same_as_orders: null, order_id: null }),
    ]);
  });

  it("lists corrected member-since dates beside the date the orders give, and links the earliest order", async () => {
    await insertOrder({ id: "1", email: "pat@example.com", created: "2024-01-15T00:00:00Z" });
    await insertOrder({ id: "2", email: "pat@example.com", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "sq-void", source: "squarespace", email: "pat@example.com", created: "2019-01-15T00:00:00Z", status: "CANCELED", counted: 0 });
    await insertMember({ id: "LV-1", email: "pat@example.com", first: "Pat", last: "Lee", memberSince: "2024-01-15" });
    await insertMember({ id: "LV-2", email: "sam@example.com", first: "Sam", last: "Ray", memberSince: "2025-05-01" });
    await insertMemberSince({ email: "pat@example.com", date: "2018-06-01", source: "manual", note: "founding member", at: 2000 });
    await insertMemberSince({ email: "sam@example.com", date: "2025-05-01", source: "legacy_postgres", at: 1000 });

    const { memberSince } = await consolidations(env.DB);

    expect(memberSince).toEqual([
      {
        member_email: "pat@example.com", member_since: "2018-06-01", order_member_since: "2024-01-15", same_as_orders: 0,
        // An admin since removed: the correction stands, unattributed.
        source: "manual", set_by: null, set_at: 2000, note: "founding member",
        // The earliest counted order; the cancelled one before it never counted.
        order_id: "1",
      },
      expect.objectContaining({ member_email: "sam@example.com", same_as_orders: 1, source: "legacy_postgres" }),
    ]);
  });
});
