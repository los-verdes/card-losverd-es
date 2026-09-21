import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeMemberships,
  consolidations,
  expiredMemberships,
  listChannels,
  ordersByMonth,
  slackCrossReference,
} from "../../src/admin/reportQueries";
import { insertOrder, insertSlackUser } from "./fixtures";

const AS_OF = "2026-06-01T12:00:00Z";

beforeEach(async () => {
  // Current, and renewed early: two orders in force at AS_OF, one member.
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
  await insertOrder({ id: "sq-void", source: "squarespace", email: "void@example.com", created: "2026-02-02T00:00:00Z", status: "CANCELED" });
  // Not yet placed at AS_OF.
  await insertOrder({ id: "8", email: "future@example.com", created: "2026-08-01T00:00:00Z" });
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM users");
});

describe("activeMemberships", () => {
  it("lists orders in force at the instant, newest first, skipping voided ones", async () => {
    const result = await activeMemberships(env.DB, AS_OF);

    expect(result.rows.map((r) => r.order_id)).toEqual(["2", "6", "5f00000000000000000000b2", "1"]);
    expect(result.totalOrders).toBe(4);
    expect(result.totalMembers).toBe(3); // the early renewer counts once
  });

  it("answers for a past date: who was a member then", async () => {
    const result = await activeMemberships(env.DB, "2024-06-01T00:00:00Z");

    expect(result.rows.map((r) => r.order_id)).toEqual(["4", "5"]);
  });

  it("treats the expiry instant itself as no longer in force", async () => {
    const atExpiry = await activeMemberships(env.DB, "2025-03-01T00:00:00Z", { search: "lapsed" });
    const justBefore = await activeMemberships(env.DB, "2025-02-28T23:59:59Z", { search: "lapsed" });

    expect(atExpiry.rows).toEqual([]);
    expect(justBefore.rows.map((r) => r.order_id)).toEqual(["4"]);
  });

  it("filters by search across both emails and the billing name, case-insensitively", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { search: "RENEWER@" })).totalOrders).toBe(2);
    expect((await activeMemberships(env.DB, AS_OF, { search: "rene wer" })).totalOrders).toBe(2);
    expect((await activeMemberships(env.DB, "2024-06-01T00:00:00Z", { search: "moved@" })).rows.map((r) => r.order_id)).toEqual(["5"]);
    expect((await activeMemberships(env.DB, AS_OF, { search: "   " })).totalOrders).toBe(4);
  });

  it("treats LIKE wildcards in a search literally", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { search: "%" })).totalOrders).toBe(0);
    expect((await activeMemberships(env.DB, AS_OF, { search: "renewer_example" })).totalOrders).toBe(0);
  });

  it("filters by channel, alone and combined with search", async () => {
    expect((await activeMemberships(env.DB, AS_OF, { channel: "bigcommerce_iphone" })).rows.map((r) => r.order_id)).toEqual(["2"]);
    expect((await activeMemberships(env.DB, AS_OF, { channel: "bigcommerce_iphone", search: "steady" })).totalOrders).toBe(0);
  });

  it("pages the rows but not the totals", async () => {
    const result = await activeMemberships(env.DB, AS_OF, {}, { limit: 2, offset: 2 });

    expect(result.rows.map((r) => r.order_id)).toEqual(["5f00000000000000000000b2", "1"]);
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

  it("filters and pages", async () => {
    const asOf = "2025-06-01T00:00:00Z";

    expect((await expiredMemberships(env.DB, asOf, { search: "lap sed" })).total).toBe(1);
    expect((await expiredMemberships(env.DB, asOf, { channel: "bigcommerce_iphone" })).total).toBe(0);
    const paged = await expiredMemberships(env.DB, asOf, {}, { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});

describe("ordersByMonth", () => {
  it("counts real membership orders per month for the year and the year before, with empty months as zero", async () => {
    const months = await ordersByMonth(env.DB, 2026);

    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ month: "01", orders: 1, previous_year_orders: 0 });
    expect(months[1]).toEqual({ month: "02", orders: 0, previous_year_orders: 0 }); // all three February orders are void
    expect(months[4]).toEqual({ month: "05", orders: 1, previous_year_orders: 0 });
    expect(months[6]).toEqual({ month: "07", orders: 0, previous_year_orders: 1 });
    expect(months[7]).toEqual({ month: "08", orders: 1, previous_year_orders: 0 });
    expect(months[8]).toEqual({ month: "09", orders: 0, previous_year_orders: 1 });
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

  it("groups billing names that appear under more than one address, ignoring void and unnamed orders", async () => {
    await insertOrder({ id: "1", email: "pat@example.com", first: "Pat", last: "Lee", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "2", email: "pat@example.com", first: "Pat", last: "Lee", created: "2025-01-15T00:00:00Z" });
    await insertOrder({ id: "3", email: "p.lee@example.com", first: "pat", last: " Lee ", created: "2024-01-15T00:00:00Z" });
    await insertOrder({ id: "4", email: "solo@example.com", first: "Solo", last: "Member", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "5", email: "void@example.com", first: "Pat", last: "Lee", created: "2026-01-15T00:00:00Z", status: "Refunded" });
    await insertOrder({ id: "6", email: "nameless@example.com", first: "", last: "", created: "2026-01-15T00:00:00Z" });
    await insertOrder({ id: "7", email: "nameless2@example.com", first: "", last: "", created: "2026-01-15T00:00:00Z" });

    const { duplicateNames } = await consolidations(env.DB);

    expect(duplicateNames).toEqual([
      { name: "pat lee", member_email: "p.lee@example.com", orders: 1, latest_expires: "2025-01-15T00:00:00Z" },
      { name: "pat lee", member_email: "pat@example.com", orders: 2, latest_expires: "2027-01-15T00:00:00Z" },
    ]);
  });
});
