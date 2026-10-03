import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { recordAuditEvent } from "../../src/audit/log";
import { MemberLink } from "../../src/admin/layout";
import { loadMemberNames } from "../../src/admin/memberNames";
import worker from "../../src/index";

/**
 * Admin tables name each member as their card does, with the address
 * beneath, because a name is what an admin scans a table for. The audit log
 * is the page exercised here: it lists people by address and nothing else.
 */

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;

async function get(path: string) {
  const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } }),
    env,
    createExecutionContext(),
  );
}

async function insertMember(id: string, email: string, first: string, last: string) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, '2099-01-15', 'token', 1)`,
  )
    .bind(id, first, last, email)
    .run();
}

/** The names lookup, told apart from the audit page's own join for its actors. */
const isNamesQuery = (sql: string) => sql.trim().startsWith("SELECT m.email,");

async function about(email: string) {
  await recordAuditEvent(env, { action: "card.emailed", subjectEmail: email, actorEmail: null, detail: "Sent" });
}

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("loadMemberNames", () => {
  it("is the card's name: a chosen one first, else the name from the orders", async () => {
    await insertMember("LV-1", "pat@example.com", "Patricia", "Lee");
    await insertMember("LV-2", "sam@example.com", "Sam", "Ray");
    await env.DB.prepare(
      "INSERT INTO member_display_names (email, display_name, source) VALUES ('pat@example.com', 'Pat Lee', 'member')",
    ).run();

    const names = await loadMemberNames(env.DB);

    expect(names.get("pat@example.com")).toBe("Pat Lee");
    expect(names.get("sam@example.com")).toBe("Sam Ray");
  });

  it("leaves out a member with no name at all, so the address shows alone", async () => {
    await insertMember("LV-1", "nameless@example.com", "", "");

    expect((await loadMemberNames(env.DB)).has("nameless@example.com")).toBe(false);
  });
});

describe("a member in an admin table", () => {
  it("leads with their name, the address beneath", async () => {
    await insertMember("LV-1", "pat@example.com", "Pat", "Lee");
    await about("pat@example.com");

    const body = await (await get("/admin/audit")).text();

    expect(body).toContain('class="member-link">Pat Lee<span class="member-email">pat@example.com</span></a>');
  });

  it("is the address alone for somebody with no membership", async () => {
    await about("stranger@example.com");

    const body = await (await get("/admin/audit")).text();

    expect(body).toContain(">stranger@example.com</a>");
    expect(body).not.toContain('class="member-email">stranger@example.com');
  });

  it("reads every name in one query, however many rows ask", async () => {
    await insertMember("LV-1", "pat@example.com", "Pat", "Lee");
    await insertMember("LV-2", "sam@example.com", "Sam", "Ray");
    for (const email of ["pat@example.com", "sam@example.com", "pat@example.com"]) await about(email);
    const prepare = vi.spyOn(env.DB, "prepare");

    const body = await (await get("/admin/audit")).text();

    expect(body).toContain("Sam Ray");
    expect(prepare.mock.calls.filter(([sql]) => isNamesQuery(sql))).toHaveLength(1);
  });

  it("falls back to addresses, rather than failing the page, when the names can't be read", async () => {
    await insertMember("LV-1", "pat@example.com", "Pat", "Lee");
    await about("pat@example.com");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (isNamesQuery(sql)) throw new Error("D1 is having a bad day");
      return prepare(sql);
    });

    const res = await get("/admin/audit");

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("member-email");
  });

  it("shows the address alone outside a request, where there is nothing to read names with", async () => {
    expect(String(await MemberLink({ email: "pat@example.com" }))).toBe(
      '<a href="/admin/members?q=pat%40example.com">pat@example.com</a>',
    );
  });

  it("puts a given name over the address instead, such as an order's own, and the address alone for an empty one", async () => {
    expect(String(await MemberLink({ email: "pat@example.com", name: " Pat Buyer " }))).toBe(
      '<a href="/admin/members?q=pat%40example.com" class="member-link">Pat Buyer<span class="member-email">pat@example.com</span></a>',
    );
    expect(String(await MemberLink({ email: "pat@example.com", name: "" }))).toBe(
      '<a href="/admin/members?q=pat%40example.com">pat@example.com</a>',
    );
  });

  it("leaves the name off when asked to, where the row already names them", async () => {
    expect(String(await MemberLink({ email: "pat@example.com", plain: true }))).toBe(
      '<a href="/admin/members?q=pat%40example.com">pat@example.com</a>',
    );
  });
});
