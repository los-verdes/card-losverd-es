import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemberSince } from "../../src/admin/memberSince";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";

/**
 * Correcting a date is not a developer's job, which makes these guard rails
 * the point rather than an extra: whoever uses the form will not be reading
 * the schema, and a wrong date here is shown on a card. The form is a section
 * of the member's admin page (#331).
 */

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;
const PATH = "/admin/members";
const OLD_PATH = "/admin/member-since";
const memberPage = (email: string) => `${PATH}?q=${encodeURIComponent(email)}`;
const TODAY = "2026-09-19";

async function request(path: string, init: RequestInit = {}, loggedInAs: number | null = ADMIN_ID) {
  const headers = new Headers(init.headers);
  if (loggedInAs !== null) {
    const token = await issueSessionToken(SESSION_KEY, {
      userId: loggedInAs,
      isAdmin: loggedInAs === ADMIN_ID,
    });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { ...init, headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

/** A POST as the form makes it, origin header included for `csrf()`. */
function post(body: Record<string, string>) {
  return request(PATH, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://card.losverd.es",
    },
    body: new URLSearchParams(body).toString(),
  });
}

async function insertMember(email: string, memberSince: string | null) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email,
       expiration_date, member_since, auth_token, last_updated_at)
     VALUES ('LV-1', 'Pat', 'Lee', ?, '2099-01-15', ?, 'token', 1)`,
  )
    .bind(email, memberSince)
    .run();
}

const overrideRow = () =>
  env.DB.prepare("SELECT email, member_since, source, note FROM member_since_overrides").first<{
    email: string;
    member_since: string;
    source: string;
    note: string | null;
  }>();

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'member@example.com', 0)").bind(MEMBER_ID).run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("the page it replaced", () => {
  it("is admin-only still", async () => {
    expect((await request(OLD_PATH, {}, null)).status).toBe(302);
    expect((await request(OLD_PATH, {}, MEMBER_ID)).status).toBe(403);
  });

  it("sends a link to someone's dates to that section of their member page", async () => {
    const res = await request(`${OLD_PATH}?email=Pat%40Example.com`);

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/admin/members?q=pat%40example.com#member-since");
  });

  it("sends one without an address to the search", async () => {
    const res = await request(OLD_PATH);

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/admin/members");
  });
});

describe("parseMemberSince", () => {
  it("accepts a real past date and trims the note", () => {
    expect(parseMemberSince("  Pat@Example.com ", "2016-03-01", "  founding member ", TODAY)).toEqual({
      email: "pat@example.com",
      date: "2016-03-01",
      note: "founding member",
    });
  });

  it("refuses a date that looks right but isn't a day", () => {
    // `Date.parse` would take this and quietly return 2 March. Someone
    // correcting a date by hand deserves to be told, not silently obeyed.
    expect(parseMemberSince("pat@example.com", "2021-02-30", "", TODAY)).toEqual({
      error: "Enter a real date, as YYYY-MM-DD.",
    });
  });

  it("refuses a future date", () => {
    expect(parseMemberSince("pat@example.com", "2026-09-20", "", TODAY)).toMatchObject({
      error: expect.stringContaining("can't be in the future"),
    });
  });

  it("accepts today", () => {
    expect(parseMemberSince("pat@example.com", TODAY, "", TODAY)).toMatchObject({ date: TODAY });
  });

  it("questions a date from before the group existed", () => {
    expect(parseMemberSince("pat@example.com", "1999-01-01", "", TODAY)).toMatchObject({
      error: expect.stringContaining("typos"),
    });
  });

  it("refuses a note long enough to be something other than a note", () => {
    expect(parseMemberSince("pat@example.com", "2016-03-01", "x".repeat(501), TODAY)).toMatchObject({
      error: expect.stringContaining("under 500 characters"),
    });
  });

  it("refuses an address that isn't one", () => {
    expect(parseMemberSince("not-an-address", "2016-03-01", "", TODAY)).toMatchObject({
      error: expect.stringContaining("valid email"),
    });
  });
});

describe("the section on the member page", () => {
  it("shows the derived date and the correction apart, which is the question being answered", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source, note) VALUES ('pat@example.com', '2016-03-01', 'manual', 'founding member')",
    ).run();

    const html = await (await request(memberPage("pat@example.com"))).text();
    const section = html.slice(html.indexOf('id="member-since"'));

    expect(section).toContain("Mar 1, 2016 (corrected)");
    expect(section).toContain("Apr 1, 2023");
    expect(section).toContain("founding member");
    // The summary says so too, and leads to the section.
    expect(html).toContain('Mar 1, 2016 (<a href="#member-since">corrected</a>)');
  });

  it("offers to go back to the orders' date for an admin's correction", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2016-03-01', 'manual')",
    ).run();

    const html = await (await request(memberPage("pat@example.com"))).text();

    expect(html).toContain('value="member-since-clear"');
    expect(html).toContain("Use the date from their orders instead");
  });

  it("offers no way to remove an imported date, and says why", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2018-01-01', 'legacy_postgres')",
    ).run();

    const html = await (await request(memberPage("pat@example.com"))).text();

    expect(html).toContain("imported from the old site");
    expect(html).not.toContain('value="member-since-clear"');
    expect(html).toContain("can be corrected but not removed");
  });

  it("offers nothing to remove when the date is the orders' own", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    const html = await (await request(memberPage("pat@example.com"))).text();

    expect(html).toContain("Apr 1, 2023 (from their orders)");
    expect(html).not.toContain('value="member-since-clear"');
  });
});

describe("saving a correction", () => {
  it("records it as manual, so a re-run of the legacy import can't undo it", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    const res = await post({ email: "pat@example.com", action: "member-since", member_since: "2016-03-01", note: "paper records" });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/members?q=pat%40example.com&saved=member-since");
    expect(await overrideRow()).toEqual({
      email: "pat@example.com",
      member_since: "2016-03-01",
      source: "manual",
      note: "paper records",
    });
  });

  it("records which admin moved the date, and shows it back", async () => {
    // Moving the date the group has been told somebody joined is a decision
    // somebody will be asked about. A note nobody can attribute answers half
    // the question.
    await insertMember("pat@example.com", "2023-04-01");

    await post({ email: "pat@example.com", action: "member-since", member_since: "2016-03-01", note: "paper records" });

    const row = await env.DB.prepare("SELECT set_by FROM member_since_overrides").first<{ set_by: number | null }>();
    expect(row?.set_by).toBe(ADMIN_ID);

    const html = await (await request(memberPage("pat@example.com"))).text();
    expect(html).toContain("by admin@example.com");
  });

  it("rebuilds the member's pass, via the table's trigger rather than a push", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    await post({ email: "pat@example.com", action: "member-since", member_since: "2016-03-01", note: "" });

    const member = await env.DB.prepare("SELECT last_updated_at FROM members WHERE email = 'pat@example.com'")
      .first<{ last_updated_at: number }>();
    expect(member!.last_updated_at).toBeGreaterThan(1);
  });

  it("replaces an imported date, keeping it manual from then on", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2018-01-01', 'legacy_postgres')",
    ).run();

    await post({ email: "pat@example.com", action: "member-since", member_since: "2016-03-01", note: "" });

    expect(await overrideRow()).toMatchObject({ member_since: "2016-03-01", source: "manual" });
  });

  it("sends a rejected date back to the page rather than showing an error page", async () => {
    const res = await post({ email: "pat@example.com", action: "member-since", member_since: "2021-02-30", note: "" });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("error=");
    expect(await overrideRow()).toBeNull();
  });
});

describe("removing a correction", () => {
  it("removes a manual one and falls back to the orders", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2016-03-01', 'manual')",
    ).run();

    const res = await post({ email: "pat@example.com", action: "member-since-clear" });

    expect(res.headers.get("Location")).toContain("saved=member-since-cleared");
    expect(await overrideRow()).toBeNull();
  });

  it("never removes an imported one, the only record of a Squarespace-era membership", async () => {
    // The old site is gone, so its dates cannot be recovered if deleted.
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2018-01-01', 'legacy_postgres')",
    ).run();

    const res = await post({ email: "pat@example.com", action: "member-since-clear" });

    expect(res.headers.get("Location")).toContain("error=");
    expect(await overrideRow()).toMatchObject({ source: "legacy_postgres" });
  });
});

describe("the audit log", () => {
  it("records a correction and its removal, with the date each replaced", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    await post({ email: "pat@example.com", action: "member-since", member_since: "2016-03-01", note: "paper records" });
    await post({ email: "pat@example.com", action: "member-since", member_since: "2015-06-01", note: "" });
    await post({ email: "pat@example.com", action: "member-since-clear" });

    const { results } = await env.DB.prepare(
      "SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY id",
    ).all();
    expect(results).toEqual([
      { action: "member_since.set", subject_email: "pat@example.com", actor_email: "admin@example.com", detail: "2016-03-01 -- paper records" },
      { action: "member_since.set", subject_email: "pat@example.com", actor_email: "admin@example.com", detail: "2015-06-01 (was 2016-03-01)" },
      { action: "member_since.cleared", subject_email: "pat@example.com", actor_email: "admin@example.com", detail: "Was 2015-06-01; back to what the orders say" },
    ]);
  });
});
