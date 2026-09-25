import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { readAuditLog, recordAuditEvent } from "../../src/audit/log";
import { AUDIT_PAGE_SIZE } from "../../src/admin/audit";
import { expelPerson, readmitPerson } from "../../src/member/expulsion";
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
  await env.DB.exec("DELETE FROM expelled_people");
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
    // The whole reason for the table. Lifting deletes the `expelled_people`
    // row, so without this there is no record that it ever happened -- and an
    // appeal is exactly when somebody asks.
    await expelPerson(env, EMAIL, "a recorded reason", ADMIN_ID);
    await readmitPerson(env, EMAIL, OTHER_ADMIN_ID);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM expelled_people").first<{ n: number }>())
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
    await expelPerson(env, EMAIL, "the first reason", ADMIN_ID);
    await expelPerson(env, EMAIL, "a second attempt", OTHER_ADMIN_ID);

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

describe("paging back through it", () => {
  /** `n` entries about `about`, oldest first; returns their ids, newest first. */
  async function record(n: number, about: string | null = EMAIL): Promise<number[]> {
    for (let i = 0; i < n; i++) {
      await recordAuditEvent(env, { action: "card.emailed", subjectEmail: about, actorEmail: null, detail: `entry ${i}` });
    }
    const { results } = await env.DB.prepare("SELECT id FROM audit_log ORDER BY id DESC").all<{ id: number }>();
    return results.map((row) => row.id);
  }

  it("shows a page at a time, with a link to the older ones", async () => {
    const ids = await record(AUDIT_PAGE_SIZE + 1);

    const body = await (await get("/admin/audit")).text();

    expect(body.split("Card emailed").length - 1).toBe(AUDIT_PAGE_SIZE);
    expect(body).toContain(`<a href="/admin/audit?before=${ids[AUDIT_PAGE_SIZE - 1]}">Older entries</a>`);
    expect(body).not.toContain("Newest entries");
  });

  it("follows the older link to the rest, with a way back and nothing further", async () => {
    const ids = await record(AUDIT_PAGE_SIZE + 1);

    const body = await (await get(`/admin/audit?before=${ids[AUDIT_PAGE_SIZE - 1]}`)).text();

    expect(body).toContain("Older entries.");
    expect(body.split("Card emailed").length - 1).toBe(1);
    expect(body).toContain(">entry 0<");
    expect(body).toContain('<a href="/admin/audit">Newest entries</a>');
    expect(body).not.toContain(">Older entries<");
  });

  it("keeps to one person while paging through their history", async () => {
    await record(3, "someone.else@example.com");
    const ids = await record(AUDIT_PAGE_SIZE + 1);

    const first = await (await get(`/admin/audit?email=${encodeURIComponent(EMAIL)}`)).text();
    expect(first).toContain(`<a href="/admin/audit?email=jane%40example.com&amp;before=${ids[AUDIT_PAGE_SIZE - 1]}">Older entries</a>`);

    const second = await (await get(`/admin/audit?email=${encodeURIComponent(EMAIL)}&before=${ids[AUDIT_PAGE_SIZE - 1]}`)).text();
    expect(second.split("Card emailed").length - 1).toBe(1);
    expect(second).toContain('<a href="/admin/audit?email=jane%40example.com">Newest entries</a>');
  });

  it("offers both ways from a page in the middle", async () => {
    const ids = await record(2 * AUDIT_PAGE_SIZE + 1);

    const body = await (await get(`/admin/audit?before=${ids[AUDIT_PAGE_SIZE - 1]}`)).text();

    expect(body).toContain(
      `<a href="/admin/audit">Newest entries</a> · <a href="/admin/audit?before=${ids[2 * AUDIT_PAGE_SIZE - 1]}">Older entries</a>`,
    );
  });

  it("says so when there is nothing older", async () => {
    const [only] = await record(1);

    expect(await (await get(`/admin/audit?before=${only}`)).text()).toContain("Nothing older than that.");
  });

  it.each(["abc", "0", "-5", "1.5", "99999999999999999999"])("shows the newest page for a mangled before=%s", async (raw) => {
    await record(1);

    const body = await (await get(`/admin/audit?before=${encodeURIComponent(raw)}`)).text();

    expect(body).toContain(">entry 0<");
    expect(body).toContain("The most recent entries");
  });
});

describe("downloading it", () => {
  async function csv(path: string) {
    const res = await get(path);
    return { res, text: await res.text() };
  }

  it("downloads everything, not just a page, with the labels a reader needs", async () => {
    for (let i = 0; i <= AUDIT_PAGE_SIZE; i++) {
      await recordAuditEvent(env, { action: "card.emailed", subjectEmail: EMAIL, actorEmail: null, detail: `entry ${i}` });
    }

    const { res, text } = await csv("/admin/audit?format=csv");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,when_utc,action,what,who_it_was_about,detail,who_did_it");
    expect(lines).toHaveLength(AUDIT_PAGE_SIZE + 2);
    expect(lines[1]).toMatch(/^\d+,\d{4}-\d{2}-\d{2}T[\d:.]+Z,card\.emailed,Card emailed,jane@example\.com,entry 100,$/);
  });

  it("records each download, by whom and how much", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);

    await csv("/admin/audit?format=csv");

    const [latest] = await readAuditLog(env);
    expect(latest.action).toBe("audit_log.exported");
    expect(latest.actor_email).toBe("admin@example.com");
    expect(latest.subject_email).toBeNull();
    expect(latest.detail).toBe("Downloaded 1 entry");
    expect(await (await get("/admin/audit")).text()).toContain("Audit log downloaded");
  });

  it("downloads one person's history, and records it against them", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);
    await setDisplayName(env, "someone.else@example.com", "Other", "admin", null, ADMIN_ID);

    const { text } = await csv(`/admin/audit?email=${encodeURIComponent(EMAIL)}&format=csv`);

    expect(text).toContain("membership.revoked");
    expect(text).not.toContain("someone.else@example.com");
    const [latest] = await readAuditLog(env, { email: EMAIL });
    expect(latest.action).toBe("audit_log.exported");
    expect(latest.detail).toBe("Downloaded 1 entry for jane@example.com");
  });

  it("writes a verb it has no label for as it was stored", async () => {
    await env.DB.prepare("INSERT INTO audit_log (action, subject_email, actor_email, detail) VALUES ('retired.verb', NULL, NULL, 'old')").run();

    const { text } = await csv("/admin/audit?format=csv");

    expect(text).toContain(",retired.verb,retired.verb,,old,");
  });

  it("counts entries in the plural", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);
    await restoreCard(env, CARD, ADMIN_ID);

    await csv("/admin/audit?format=csv");

    expect((await readAuditLog(env))[0].detail).toBe("Downloaded 2 entries");
  });

  it("offers the download on the page, filtered the same way", async () => {
    expect(await (await get("/admin/audit")).text()).toContain('<a href="/admin/audit?format=csv">Download the whole log as CSV</a>');
    expect(await (await get(`/admin/audit?email=${encodeURIComponent(EMAIL)}`)).text()).toContain(
      '<a href="/admin/audit?email=jane%40example.com&amp;format=csv">Download their whole history as CSV</a>',
    );
  });

  it("refuses the download to anyone who is not an admin", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, ?, 0)").bind("member@example.com").run();

    expect((await get("/admin/audit?format=csv", 9)).status).toBe(403);
    expect(await readAuditLog(env)).toHaveLength(0);
  });
});
