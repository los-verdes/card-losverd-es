import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { isRevoked, revokeCard } from "../../src/member/revocation";
import { banPerson, isBanned } from "../../src/member/ban";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const CARD = "LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6";
const EMAIL = "jane@example.com";

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(ADMIN_ID, "admin@example.com")
    .run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status,
       expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'active', '2099-03-04', '2021-07-15', 'token', 1)`,
  )
    .bind(CARD, EMAIL)
    .run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM banned_people");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function request(
  init: RequestInit & { path?: string } = {},
  asUser: number | null = ADMIN_ID,
) {
  const headers = new Headers(init.headers);
  if (asUser !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: asUser, isAdmin: true });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  if (init.method === "POST") headers.set("Origin", "https://card.losverd.es");
  return worker.fetch(
    new Request(`https://card.losverd.es${init.path ?? "/admin/revocations"}`, {
      ...init,
      headers,
      redirect: "manual",
    }),
    env,
    createExecutionContext(),
  );
}

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return { method: "POST" as const, body };
}

describe("the withdrawn and barred page", () => {
  it("says plainly when there is nothing on either list", async () => {
    // The ordinary state, and the one worth being unambiguous about: an
    // empty page should read as "nobody" rather than as a page that failed
    // to load.
    const res = await request();

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No membership has been withdrawn");
    expect(body).toContain("Nobody is barred");
  });

  it("lists a withdrawn card with its reason and who decided it", async () => {
    await revokeCard(env, CARD, "a recorded reason", ADMIN_ID);

    const body = await (await request()).text();

    expect(body).toContain(CARD);
    expect(body).toContain(EMAIL);
    expect(body).toContain("a recorded reason");
    expect(body).toContain("admin@example.com");
  });

  it("lists a barred person, and whether they hold a membership", async () => {
    await banPerson(env, EMAIL, "another reason", ADMIN_ID);

    const body = await (await request()).text();

    expect(body).toContain(EMAIL);
    expect(body).toContain("another reason");
    expect(body).toContain("Barred from the group");
  });

  it("copes with a ban on somebody who has never bought anything", async () => {
    await banPerson(env, "stranger@example.com", null, ADMIN_ID);

    const res = await request();

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("stranger@example.com");
  });

  it("restores a withdrawn membership", async () => {
    await revokeCard(env, CARD, null, ADMIN_ID);

    const res = await request(form({ member_id: CARD }));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("saved=restored");
    expect(await isRevoked(env, CARD)).toBe(false);
  });

  it("lifts a ban", async () => {
    await banPerson(env, EMAIL, null, ADMIN_ID);

    const res = await request(form({ action: "unban", email: EMAIL }));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("saved=unbanned");
    expect(await isBanned(env, EMAIL)).toBe(false);
  });

  it("says so rather than pretending, when the card was not withdrawn", async () => {
    const res = await request(form({ member_id: CARD }));

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("says so rather than pretending, when the person was not barred", async () => {
    const res = await request(form({ action: "unban", email: EMAIL }));

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("refuses a restore with no card named", async () => {
    const res = await request(form({ member_id: "  " }));

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("refuses a lift with no person named", async () => {
    const res = await request(form({ action: "unban", email: "  " }));

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("shows what just happened, and what went wrong", async () => {
    expect(await (await request({ path: "/admin/revocations?saved=restored" })).text()).toContain(
      "Membership restored",
    );
    expect(await (await request({ path: "/admin/revocations?saved=unbanned" })).text()).toContain(
      "Ban lifted",
    );
    expect(
      await (await request({ path: "/admin/revocations?error=That+card+was+not+withdrawn." })).text(),
    ).toContain("That card was not withdrawn.");
  });

  it("is admin-only, and never cached", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, ?, 0)")
      .bind("member@example.com")
      .run();

    expect((await request({}, 9)).status).toBe(403);
    expect((await request({}, null)).status).toBe(302);
    expect((await request()).headers.get("Cache-Control")).toBe("no-store");
  });
});
