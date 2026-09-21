import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemberSince } from "../../src/admin/memberSince";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";

/**
 * This page exists so that correcting a date is not a developer's job, which
 * makes its guard rails the point rather than an extra: whoever uses it will
 * not be reading the schema, and a wrong date here is shown on a card.
 */

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;
const PATH = "/admin/member-since";
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
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("access", () => {
  it("is admin-only", async () => {
    expect((await request(PATH, {}, null)).status).toBe(302);
    expect((await request(PATH, {}, MEMBER_ID)).status).toBe(403);
  });

  it("is never cached, since it shows names and addresses", async () => {
    expect((await request(PATH)).headers.get("Cache-Control")).toBe("no-store");
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

describe("the page", () => {
  it("shows the derived date and the correction apart, which is the question being answered", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source, note) VALUES ('pat@example.com', '2016-03-01', 'manual', 'founding member')",
    ).run();

    const html = await (await request(`${PATH}?email=pat@example.com`)).text();

    expect(html).toContain("Mar 1, 2016");
    expect(html).toContain("Apr 1, 2023");
    expect(html).toContain("founding member");
  });

  it("warns when no card exists for the address yet", async () => {
    const html = await (await request(`${PATH}?email=nobody@example.com`)).text();

    expect(html).toContain("No membership card exists for this address yet");
  });
});

describe("saving a correction", () => {
  it("records it as manual, so a re-run of the legacy import can't undo it", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    const res = await post({ email: "pat@example.com", member_since: "2016-03-01", note: "paper records" });

    expect(res.status).toBe(303);
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

    await post({ email: "pat@example.com", member_since: "2016-03-01", note: "paper records" });

    const row = await env.DB.prepare("SELECT set_by FROM member_since_overrides").first<{ set_by: number | null }>();
    expect(row?.set_by).toBe(ADMIN_ID);

    const html = await (await request(`${PATH}?email=pat@example.com`)).text();
    expect(html).toContain("by admin@example.com");
  });

  it("rebuilds the member's pass, via the table's trigger rather than a push", async () => {
    await insertMember("pat@example.com", "2023-04-01");

    await post({ email: "pat@example.com", member_since: "2016-03-01", note: "" });

    const member = await env.DB.prepare("SELECT last_updated_at FROM members WHERE email = 'pat@example.com'")
      .first<{ last_updated_at: number }>();
    expect(member!.last_updated_at).toBeGreaterThan(1);
  });

  it("replaces an imported date, keeping it manual from then on", async () => {
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2018-01-01', 'legacy_postgres')",
    ).run();

    await post({ email: "pat@example.com", member_since: "2016-03-01", note: "" });

    expect(await overrideRow()).toMatchObject({ member_since: "2016-03-01", source: "manual" });
  });

  it("sends a rejected date back to the page rather than showing an error page", async () => {
    const res = await post({ email: "pat@example.com", member_since: "2021-02-30", note: "" });

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

    const res = await post({ email: "pat@example.com", action: "clear" });

    expect(res.headers.get("Location")).toContain("saved=cleared");
    expect(await overrideRow()).toBeNull();
  });

  it("never removes an imported one, the only record of a Squarespace-era membership", async () => {
    // The old site is gone, so its dates cannot be recovered if deleted.
    await insertMember("pat@example.com", "2023-04-01");
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('pat@example.com', '2018-01-01', 'legacy_postgres')",
    ).run();

    const res = await post({ email: "pat@example.com", action: "clear" });

    expect(res.headers.get("Location")).toContain("error=");
    expect(await overrideRow()).toMatchObject({ source: "legacy_postgres" });
  });
});
