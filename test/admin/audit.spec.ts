import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { readAuditLog } from "../../src/audit/log";
import { banPerson, liftBan } from "../../src/member/ban";
import { revokeCard, restoreCard } from "../../src/member/revocation";
import { clearDisplayName, setDisplayName } from "../../src/member/displayName";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const OTHER_ADMIN_ID = 2;
const CARD = "LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6";
const EMAIL = "jane@example.com";

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(ADMIN_ID, "admin@example.com")
    .run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(OTHER_ADMIN_ID, "second.admin@example.com")
    .run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email,
       expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, '2099-03-04', '2021-07-15', 'token', 1)`,
  )
    .bind(CARD, EMAIL)
    .run();
});

afterEach(async () => {
  // Append-only by design, so nothing in the code clears it and every test
  // would otherwise read the previous one's entries.
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM banned_people");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function get(path: string, asUser: number | null = ADMIN_ID) {
  const headers = new Headers();
  if (asUser !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: asUser, isAdmin: true });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

describe("what the log records", () => {
  it("keeps an expulsion after it has been lifted, which nothing else does", async () => {
    // The whole reason for the table. Lifting deletes the `banned_people`
    // row, so without this there is no record that it ever happened -- and an
    // appeal is exactly when somebody asks.
    await banPerson(env, EMAIL, "a recorded reason", ADMIN_ID);
    await liftBan(env, EMAIL, OTHER_ADMIN_ID);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM banned_people").first<{ n: number }>())
      .toEqual({ n: 0 });

    const entries = await readAuditLog(env, { email: EMAIL });
    expect(entries.map((e) => e.action)).toEqual(["person.readmitted", "person.expelled"]);
    expect(entries[1].detail).toBe("a recorded reason");
    expect(entries[1].actor_email).toBe("admin@example.com");
    expect(entries[0].actor_email).toBe("second.admin@example.com");
  });

  it("keeps a revocation after it has been restored", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);
    await restoreCard(env, CARD, ADMIN_ID);

    const actions = (await readAuditLog(env, { email: EMAIL })).map((e) => e.action);
    expect(actions).toEqual(["membership.restored", "membership.revoked"]);
  });

  it("keeps the name somebody had before it was changed", async () => {
    // The row is overwritten in place, so the previous value exists nowhere
    // else the moment the second write lands.
    await setDisplayName(env, EMAIL, "Chuy", "admin", null, ADMIN_ID);
    await setDisplayName(env, EMAIL, "Chuyito", "admin", null, ADMIN_ID);

    const entries = await readAuditLog(env, { email: EMAIL });
    expect(entries[0].detail).toBe('"Chuyito" (was "Chuy")');
  });

  it("keeps the name after it has been cleared", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "admin", null, ADMIN_ID);
    await clearDisplayName(env, EMAIL, ADMIN_ID);

    const entries = await readAuditLog(env, { email: EMAIL });
    expect(entries[0].action).toBe("display_name.cleared");
    expect(entries[0].detail).toBe('Was "Chuy"');
  });

  it("records nothing for a clear that had nothing to remove", async () => {
    await clearDisplayName(env, EMAIL, ADMIN_ID);

    expect(await readAuditLog(env, { email: EMAIL })).toEqual([]);
  });

  it("attributes a member's own change to them rather than to an admin", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "member", null, ADMIN_ID);

    const entries = await readAuditLog(env, { email: EMAIL });
    expect(entries[0].detail).toContain("set by the member themselves");
  });

  it("leaves the actor empty for the one-time legacy import", async () => {
    // Nobody made that decision here, and naming whoever ran the import
    // would say they did.
    await setDisplayName(env, EMAIL, "Chuy", "legacy_postgres", null, ADMIN_ID);

    expect((await readAuditLog(env, { email: EMAIL }))[0].actor_email).toBeNull();
  });

  it("does not restamp a decision that was already in force", async () => {
    await banPerson(env, EMAIL, "the first reason", ADMIN_ID);
    await banPerson(env, EMAIL, "a second attempt", OTHER_ADMIN_ID);

    const entries = await readAuditLog(env, { email: EMAIL });
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe("the first reason");
  });
});

describe("reading it back", () => {
  it("shows one person's history, newest first", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);
    await restoreCard(env, CARD, ADMIN_ID);

    const body = await (await get(`/admin/audit?email=${encodeURIComponent(EMAIL)}`)).text();

    expect(body).toContain("Membership restored");
    expect(body).toContain("Membership revoked");
    expect(body).toContain("admin@example.com");
    expect(body.indexOf("Membership restored")).toBeLessThan(body.indexOf("Membership revoked"));
  });

  it("shows everything when no address is given, with a link per person", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);

    const body = await (await get("/admin/audit")).text();

    expect(body).toContain("Who it was about");
    expect(body).toContain(`/admin/audit?email=${encodeURIComponent(EMAIL)}`);
  });

  it("says so plainly when there is nothing to show", async () => {
    expect(await (await get("/admin/audit")).text()).toContain("Nothing recorded yet");
    const filtered = await (await get("/admin/audit?email=nobody@example.com")).text();
    expect(filtered).toContain("Nothing has been recorded against this address");
  });

  it("is linked from the member's own page", async () => {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain(`/admin/audit?email=${encodeURIComponent(EMAIL)}`);
  });

  it("is admin-only, and never cached", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, ?, 0)")
      .bind("member@example.com")
      .run();

    expect((await get("/admin/audit", 9)).status).toBe(403);
    expect((await get("/admin/audit", null)).status).toBe(302);
    expect((await get("/admin/audit")).headers.get("Cache-Control")).toBe("no-store");
  });

  it("caps how much it will return, however much is asked for", async () => {
    // A page that returns everything stops being readable long before it
    // stops being expensive.
    const { readAuditLog: read } = await import("../../src/audit/log");
    await revokeCard(env, CARD, "conduct", ADMIN_ID);

    expect(await read(env, { limit: 100_000 })).toHaveLength(1);
    expect(await read(env, { limit: 0 })).toHaveLength(1);
  });
});
