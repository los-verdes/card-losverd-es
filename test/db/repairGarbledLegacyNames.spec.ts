import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { insertCardName, insertMember, insertOrder } from "../admin/fixtures";

// The migration already ran, on empty tables, when the database was set up;
// these run its statements again over rows that exercise each case. Names are
// invented; "�" is the replacement character the previous site left.
const MIGRATION = Object.values(
  import.meta.glob("../../src/db/migrations/0008_*.sql", { query: "?raw", import: "default", eager: true }),
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

const LOST = "�";

async function orderName(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT first_name || ' ' || last_name AS name FROM membership_orders WHERE order_id = ?").bind(id).first<{ name: string }>();
  return row!.name;
}

async function cardName(email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT display_name FROM member_display_names WHERE email = ?").bind(email).first<{ display_name: string }>();
  return row?.display_name ?? null;
}

beforeEach(async () => {
  // An imported Squarespace order with a lost letter, and a later clean one.
  await insertOrder({ id: "5f00000000000000000000a1", source: "squarespace", email: "rosa@example.com", first: "Rosa", last: `Mu${LOST}oz`, created: "2021-04-01T00:00:00Z", status: null, channel: null });
  await insertOrder({ id: "1001", email: "rosa@example.com", first: "Rosa", last: "Muñoz", created: "2024-04-01T00:00:00Z" });
  await insertMember({ id: "LV-rosa", email: "rosa@example.com", first: "Rosa", last: "Muñoz", memberSince: "2021-04-01" });
  await insertCardName({ email: "rosa@example.com", name: `ROSA MU${LOST}OZ`, source: "legacy_postgres", at: 1 });
  // Two letters lost from a card name.
  await insertOrder({ id: "1004", email: "jose@example.com", first: "José", last: "Núñez", created: "2024-08-01T00:00:00Z" });
  await insertMember({ id: "LV-jose", email: "jose@example.com", first: "José", last: "Núñez", memberSince: "2024-08-01" });
  await insertCardName({ email: "jose@example.com", name: `Jos${LOST} N${LOST}ñez`, source: "legacy_postgres", at: 1 });
  // Lost letters and nothing clean to restore them from: left alone.
  await insertOrder({ id: "5f00000000000000000000a2", source: "squarespace", email: "iker@example.com", first: `I${LOST}aki`, last: "Ruiz", created: "2021-05-01T00:00:00Z", status: null, channel: null });
  await insertMember({ id: "LV-iker", email: "iker@example.com", first: "Iker", last: "Ruiz", memberSince: "2021-05-01" });
  await insertCardName({ email: "iker@example.com", name: `I${LOST}aki R.`, source: "legacy_postgres", at: 1 });
  // A clean name that does not fit the pattern is not taken for it.
  await insertOrder({ id: "5f00000000000000000000a3", source: "squarespace", email: "lucia@example.com", first: `Luc${LOST}a`, last: "Paz", created: "2021-06-01T00:00:00Z", status: null, channel: null });
  await insertOrder({ id: "1002", email: "lucia@example.com", first: "Lucia", last: "Pazos", created: "2024-06-01T00:00:00Z" });
  // A name with a wildcard character of its own is matched literally.
  await insertOrder({ id: "5f00000000000000000000a4", source: "squarespace", email: "under@example.com", first: `Jo_${LOST}`, last: "Lee", created: "2021-07-01T00:00:00Z", status: null, channel: null });
  await insertOrder({ id: "1003", email: "under@example.com", first: "Joxé", last: "Lee", created: "2024-07-01T00:00:00Z" });
  await env.DB.exec("UPDATE members SET last_updated_at = 1");
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
});

it("restores an order's lost letter from a clean order of the same person", async () => {
  await migrate();

  expect(await orderName("5f00000000000000000000a1")).toBe("Rosa Muñoz");
});

it("guesses nothing: a lost letter with no matching clean copy stays as it is", async () => {
  await migrate();

  expect(await orderName("5f00000000000000000000a2")).toBe(`I${LOST}aki Ruiz`);
  expect(await orderName("5f00000000000000000000a3")).toBe(`Luc${LOST}a Paz`);
  expect(await orderName("5f00000000000000000000a4")).toBe(`Jo_${LOST} Lee`);
  expect(await cardName("iker@example.com")).toBe(`I${LOST}aki R.`);
});

it("restores only the lost letters of a card name, keeping its own capitals", async () => {
  await migrate();

  // The letter comes as the orders have it; the rest stays as chosen.
  expect(await cardName("rosa@example.com")).toBe("ROSA MUñOZ");
  expect(await cardName("jose@example.com")).toBe("José Núñez");
});

it("records each repaired card name against its person, and marks their card stale", async () => {
  await migrate();

  const { results } = await env.DB.prepare("SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY subject_email").all();
  expect(results).toEqual([
    {
      action: "display_name.repaired",
      subject_email: "jose@example.com",
      actor_email: null,
      detail: `Restored the letters the previous site had lost from the card name "Jos${LOST} N${LOST}ñez", from their orders`,
    },
    {
      action: "display_name.repaired",
      subject_email: "rosa@example.com",
      actor_email: null,
      detail: `Restored the letters the previous site had lost from the card name "ROSA MU${LOST}OZ", from their orders`,
    },
  ]);
  const stale = await env.DB.prepare("SELECT email FROM members WHERE last_updated_at > 1 ORDER BY email").all<{ email: string }>();
  expect(stale.results.map((row) => row.email)).toEqual(["jose@example.com", "rosa@example.com"]);
});

it("changes nothing, and records nothing, when run again", async () => {
  await migrate();
  await env.DB.exec("UPDATE members SET last_updated_at = 1");

  await migrate();

  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n).toBe(2);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE last_updated_at > 1").first<{ n: number }>())!.n).toBe(0);
});
