import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { activeMembersByDay, type CountedOrder } from "../../src/admin/membersOverTime";
import { activeMemberships, countedMembershipOrders } from "../../src/admin/reportQueries";
import { insertMember, insertOrder } from "./fixtures";

const order = (member: string, created: string, expires: string): CountedOrder => ({
  member_email: member,
  created_on: `${created}T00:00:00Z`,
  expires_on: `${expires}T00:00:00Z`,
});

function members(series: { day: string; members: number }[]): Record<string, number> {
  return Object.fromEntries(series.map((point) => [point.day, point.members]));
}

describe("activeMembersByDay", () => {
  it("counts a member from the day they bought until the day before it expires", () => {
    const series = activeMembersByDay([order("a@example.com", "2026-01-02", "2026-01-04")], "2026-01-01", "2026-01-05");

    expect(members(series)).toEqual({
      "2026-01-01": 0,
      "2026-01-02": 1,
      "2026-01-03": 1,
      "2026-01-04": 0,
      "2026-01-05": 0,
    });
  });

  it("counts somebody who renewed early once, however their orders overlap", () => {
    const series = activeMembersByDay(
      [order("a@example.com", "2026-01-01", "2026-01-10"), order("a@example.com", "2026-01-05", "2026-01-20")],
      "2026-01-01",
      "2026-01-25",
    );

    expect(Math.max(...series.map((point) => point.members))).toBe(1);
    expect(members(series)["2026-01-19"]).toBe(1);
    expect(members(series)["2026-01-20"]).toBe(0);
  });

  it("counts a renewal on the very day the last one ran out as unbroken, and a later one after a gap", () => {
    const series = activeMembersByDay(
      [
        order("a@example.com", "2026-01-01", "2026-01-05"),
        order("a@example.com", "2026-01-05", "2026-01-08"),
        order("a@example.com", "2026-01-10", "2026-01-12"),
      ],
      "2026-01-01",
      "2026-01-12",
    );

    expect(series.map((point) => point.members).join("")).toBe("111111100110");
  });

  it("adds up different members, and counts those whose membership began before the window", () => {
    const series = activeMembersByDay(
      [order("a@example.com", "2025-06-01", "2026-06-01"), order("b@example.com", "2026-01-02", "2027-01-02")],
      "2026-01-01",
      "2026-01-02",
    );

    expect(members(series)).toEqual({ "2026-01-01": 1, "2026-01-02": 2 });
  });

  it("gives nothing for a window that ends before it starts", () => {
    expect(activeMembersByDay([], "2026-01-02", "2026-01-01")).toEqual([]);
  });
});

describe("against the Active memberships report", () => {
  afterEach(async () => {
    await env.DB.exec("DELETE FROM revoked_cards");
    await env.DB.exec("DELETE FROM expelled_people");
    await env.DB.exec("DELETE FROM membership_orders");
    await env.DB.exec("DELETE FROM members");
  });

  it("agrees with it about every day", async () => {
    // A renewal, a lapse and a return, a refund, a Squarespace-era order, a
    // revoked membership and an expulsion: everything that decides who counts.
    await insertOrder({ id: "1", email: "renewer@example.com", created: "2024-02-10T00:00:00Z" });
    await insertOrder({ id: "2", email: "renewer@example.com", created: "2025-01-20T00:00:00Z" });
    await insertOrder({ id: "3", email: "returner@example.com", created: "2024-03-01T00:00:00Z" });
    await insertOrder({ id: "4", email: "returner@example.com", created: "2025-06-15T00:00:00Z" });
    await insertOrder({ id: "5", email: "refunded@example.com", created: "2024-05-01T00:00:00Z", status: "Refunded" });
    await insertOrder({ id: "5f00000000000000000000d4", source: "squarespace", email: "early@example.com", created: "2024-01-05T00:00:00Z", status: null, channel: null });
    await insertOrder({ id: "6", email: "revoked@example.com", created: "2024-04-01T00:00:00Z" });
    await insertMember({ id: "LV-revoked", email: "revoked@example.com", first: "Re", last: "Voked", memberSince: "2024-04-01" });
    await env.DB.prepare("INSERT INTO revoked_cards (member_id, note) VALUES ('LV-revoked', 'test')").run();
    await insertOrder({ id: "7", email: "expelled@example.com", created: "2024-04-01T00:00:00Z" });
    await env.DB.prepare("INSERT INTO expelled_people (email, note) VALUES ('expelled@example.com', 'test')").run();

    const series = activeMembersByDay(await countedMembershipOrders(env.DB), "2024-01-01", "2026-08-01");

    for (const point of series.filter((_, i) => i % 7 === 0 || i < 40)) {
      const report = await activeMemberships(env.DB, `${point.day}T23:59:59Z`);
      expect(point.members, point.day).toBe(report.totalMembers);
    }
    expect(Math.max(...series.map((point) => point.members))).toBe(3);
  });
});
