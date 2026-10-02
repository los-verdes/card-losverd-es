import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COUNTS_AS_MEMBERSHIP } from "../../src/lib/membershipOrders";
import { insertCardName, insertMember, insertMemberSince, insertOrder } from "../admin/fixtures";

// The migration already ran, on empty tables, when the database was set up;
// these run its statements again over rows that exercise each rule.
const MIGRATION = Object.values(
  import.meta.glob("../../src/db/migrations/0016_drop_redundant_legacy_overrides.sql", { query: "?raw", import: "default", eager: true }),
)[0] as string;

const STATEMENTS = MIGRATION.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(/;\s*\n/)
  .map((statement) => statement.trim())
  .filter(Boolean);

async function migrate() {
  for (const statement of STATEMENTS) await env.DB.prepare(statement).run();
}

async function remainingDates(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT email FROM member_since_overrides ORDER BY email").all<{ email: string }>();
  return results.map((row) => row.email);
}

async function remainingNames(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT email FROM member_display_names ORDER BY email").all<{ email: string }>();
  return results.map((row) => row.email);
}

async function audit(): Promise<{ action: string; subject_email: string | null; actor_email: string | null; detail: string }[]> {
  const { results } = await env.DB.prepare("SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY id").all<{
    action: string;
    subject_email: string | null;
    actor_email: string | null;
    detail: string;
  }>();
  return results;
}

const member = (id: string, email: string, first: string, last: string, memberSince: string | null) =>
  insertMember({ id, email, first, last, memberSince });

afterEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
});

it("spells out the same rule for what counts as a membership as the code does", () => {
  const unqualified = MIGRATION.replaceAll("x.frozen_counts", "frozen_counts")
    .replaceAll("lower(x.status)", "lower(status)")
    .replaceAll("x.membership_units", "membership_units");

  expect(unqualified).toContain(COUNTS_AS_MEMBERSHIP);
});

describe("previous-site \"member since\" dates", () => {
  beforeEach(async () => {
    // Matches its BigCommerce-only orders: changes nothing.
    await insertOrder({ id: "1", email: "same@example.com", created: "2024-02-01T00:00:00Z" });
    await member("LV-same", "same@example.com", "Sa", "Me", "2024-02-01");
    await insertMemberSince({ email: "same@example.com", date: "2024-02-01", source: "legacy_postgres", at: 1 });
    // BigCommerce-only, and earlier than its orders: drift; the orders win.
    await insertOrder({ id: "2", email: "drift@example.com", created: "2024-05-01T00:00:00Z" });
    await member("LV-drift", "drift@example.com", "Dr", "Ift", "2024-05-01");
    await insertMemberSince({ email: "drift@example.com", date: "2023-11-12", source: "legacy_postgres", at: 1 });
    // Squarespace-era orders, and a date they agree with.
    await insertOrder({ id: "5f00000000000000000000e1", source: "squarespace", email: "early@example.com", created: "2021-04-01T00:00:00Z", status: null, channel: null });
    await member("LV-early", "early@example.com", "Ea", "Rly", "2021-04-01");
    await insertMemberSince({ email: "early@example.com", date: "2021-04-01", source: "legacy_postgres", at: 1 });
    // Squarespace-era orders, and a date they do not give: the case the
    // import was for, which stays.
    await insertOrder({ id: "5f00000000000000000000e2", source: "squarespace", email: "known@example.com", created: "2022-03-01T00:00:00Z", status: null, channel: null });
    await member("LV-known", "known@example.com", "Kn", "Own", "2022-03-01");
    await insertMemberSince({ email: "known@example.com", date: "2020-06-01", source: "legacy_postgres", at: 1 });
    // No card yet, Squarespace-era orders that give the same date.
    await insertOrder({ id: "5f00000000000000000000e3", source: "squarespace", email: "unbuilt@example.com", created: "2020-09-09T00:00:00Z", status: null, channel: null });
    await insertMemberSince({ email: "unbuilt@example.com", date: "2020-09-09", source: "legacy_postgres", at: 1 });
    // No card, no orders at all.
    await insertMemberSince({ email: "nobody@example.com", date: "2020-01-01", source: "legacy_postgres", at: 1 });
    // An admin's correction, however it compares, is never touched.
    await insertOrder({ id: "3", email: "corrected@example.com", created: "2024-08-01T00:00:00Z" });
    await member("LV-corrected", "corrected@example.com", "Co", "Rrected", "2024-08-01");
    await insertMemberSince({ email: "corrected@example.com", date: "2019-01-01", source: "manual", at: 1 });
  });

  it("removes each that matches the orders or covers no Squarespace year, and keeps the rest", async () => {
    await migrate();

    expect(await remainingDates()).toEqual(["corrected@example.com", "known@example.com"]);
  });

  it("records a removal that changes a card against its person, and the rest as one line", async () => {
    await migrate();

    expect(await audit()).toEqual([
      {
        action: "member_since.cleared",
        subject_email: "drift@example.com",
        actor_email: null,
        detail: "Removed the previous site's \"member since\" of 2023-11-12; their orders give 2024-05-01, and none of them is from the Squarespace years",
      },
      {
        action: "member_since.cleared",
        subject_email: null,
        actor_email: null,
        detail: expect.stringMatching(/^Removed 5 "member since" date\(s\) carried over from the previous site/),
      },
    ]);
  });

  it("marks the changed cards stale, through the table's own triggers", async () => {
    // Setting the fixtures up fired the insert trigger; start from unmarked.
    await env.DB.exec("UPDATE members SET last_updated_at = 1");

    await migrate();

    const { results } = await env.DB.prepare("SELECT email FROM members WHERE last_updated_at > 1 ORDER BY email").all<{ email: string }>();
    expect(results.map((row) => row.email)).toEqual(["drift@example.com", "early@example.com", "same@example.com"]);
  });

  it("does nothing, and records nothing, when run again", async () => {
    await migrate();
    const before = await audit();

    await migrate();

    expect(await audit()).toEqual(before);
    expect(await remainingDates()).toEqual(["corrected@example.com", "known@example.com"]);
  });
});

describe("previous-site card names", () => {
  beforeEach(async () => {
    // The same as the card's name from its orders, bar case and spaces.
    await insertOrder({ id: "1", email: "same@example.com", first: "Pat", last: "Lee", created: "2024-02-01T00:00:00Z" });
    await member("LV-same", "same@example.com", "Pat", "Lee", "2024-02-01");
    await insertCardName({ email: "same@example.com", name: " pat lee ", source: "legacy_postgres", at: 1 });
    // A different name, perhaps one they chose: stays.
    await insertOrder({ id: "2", email: "chosen@example.com", first: "Robert", last: "Diaz", created: "2024-02-01T00:00:00Z" });
    await member("LV-chosen", "chosen@example.com", "Robert", "Diaz", "2024-02-01");
    await insertCardName({ email: "chosen@example.com", name: "Bobby Diaz", source: "legacy_postgres", at: 1 });
    // No card yet: compared with the latest counted order's name, not an older one.
    await insertOrder({ id: "5f00000000000000000000f1", source: "squarespace", email: "unbuilt@example.com", first: "Old", last: "Name", created: "2020-05-01T00:00:00Z", status: null, channel: null });
    await insertOrder({ id: "5f00000000000000000000f2", source: "squarespace", email: "unbuilt@example.com", first: "Sam", last: "Roe", created: "2021-05-01T00:00:00Z", status: null, channel: null });
    await insertCardName({ email: "unbuilt@example.com", name: "Sam Roe", source: "legacy_postgres", at: 1 });
    // No card and no counted order for a name to come from.
    await insertCardName({ email: "nobody@example.com", name: "Anyone", source: "legacy_postgres", at: 1 });
    // A member's own choice stays, even when it matches.
    await insertOrder({ id: "3", email: "own@example.com", first: "Ana", last: "Ruiz", created: "2024-02-01T00:00:00Z" });
    await member("LV-own", "own@example.com", "Ana", "Ruiz", "2024-02-01");
    await insertCardName({ email: "own@example.com", name: "Ana Ruiz", source: "member", at: 1 });
  });

  it("removes only those that change nothing, and records them as one line", async () => {
    await migrate();

    expect(await remainingNames()).toEqual(["chosen@example.com", "own@example.com"]);
    expect(await audit()).toEqual([
      {
        action: "display_name.cleared",
        subject_email: null,
        actor_email: null,
        detail: "Removed 3 card name(s) carried over from the previous site that matched the name the person's orders give, so changed nothing",
      },
    ]);
  });

  it("counts a partially refunded order while its membership wasn't refunded, as the code does", async () => {
    // No card yet, so the latest counted order names them. Partially refunded
    // with the membership kept, it counts, and the imported name matches it.
    await insertOrder({ id: "4", email: "kept@example.com", first: "Kim", last: "Old", created: "2023-02-01T00:00:00Z" });
    await insertOrder({ id: "5", email: "kept@example.com", first: "Kim", last: "Park", created: "2024-02-01T00:00:00Z", status: "Partially Refunded" });
    await insertCardName({ email: "kept@example.com", name: "Kim Park", source: "legacy_postgres", at: 1 });
    // With the membership itself refunded it does not count, so the name
    // comes from the earlier order, and the imported one differs and stays.
    await insertOrder({ id: "6", email: "refunded@example.com", first: "Lee", last: "Old", created: "2023-02-01T00:00:00Z" });
    await insertOrder({ id: "7", email: "refunded@example.com", first: "Lee", last: "New", created: "2024-02-01T00:00:00Z", status: "Partially Refunded" });
    await insertCardName({ email: "refunded@example.com", name: "Lee New", source: "legacy_postgres", at: 1 });
    await env.DB.exec("UPDATE membership_orders SET membership_units = 1, membership_units_refunded = 0 WHERE order_id = '5'");
    await env.DB.exec("UPDATE membership_orders SET membership_units = 1, membership_units_refunded = 1 WHERE order_id = '7'");

    await migrate();

    expect(await remainingNames()).toEqual(["chosen@example.com", "own@example.com", "refunded@example.com"]);
  });
});
