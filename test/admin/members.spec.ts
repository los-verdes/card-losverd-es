import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { classify } from "../../src/admin/members";
import { getDisplayName, setDisplayName } from "../../src/member/displayName";
import { isBanned, banPerson } from "../../src/member/ban";
import { isRevoked, revokeCard } from "../../src/member/revocation";
import { cardNameText, getMemberByEmail } from "../../src/member/artifacts";

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
  // Before `members`: both reference it, and D1 enforces the constraint, so
  // the delete fails and the next test's fixtures collide with what is left.
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM banned_people");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function post(fields: Record<string, string>, asUser: number | null = ADMIN_ID) {
  const headers = new Headers({ Origin: "https://card.losverd.es" });
  if (asUser !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: asUser, isAdmin: true });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return worker.fetch(
    new Request("https://card.losverd.es/admin/members", {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    }),
    env,
    createExecutionContext(),
  );
}

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

describe("working out what an admin typed", () => {
  it.each([
    ["jane@example.com", "email"],
    ["  Jane@Example.com  ", "email"],
    ["LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6", "card"],
    ["lv-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6", "card"],
    ["1001", "order"],
    ["5f00000000000000000000a1", "order"],
    ["", "empty"],
    ["   ", "empty"],
  ])("reads %j as a %s", (raw, kind) => {
    expect(classify(raw).kind).toBe(kind);
  });

  it("lower-cases an email but leaves a card number alone", () => {
    // The card number is compared against `members.member_id` as stored.
    expect(classify(" Jane@Example.com ")).toEqual({ kind: "email", value: "jane@example.com" });
    expect(classify(` ${CARD} `)).toEqual({ kind: "card", value: CARD });
  });
});

describe("finding a member", () => {
  it("finds one by the card number printed on their pass", async () => {
    // The point of the whole page: it is the one identifier a member can
    // always read out, and nothing could look one up before.
    const res = await get(`/admin/members?q=${encodeURIComponent(CARD)}`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Jane Doe");
    expect(body).toContain(EMAIL);
  });

  it("finds the same member by email", async () => {
    const res = await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`);

    expect(await res.text()).toContain(CARD);
  });

  it("shows the name they chose, and what their orders say", async () => {
    // An admin looking at a card that says something unexpected needs to see
    // both, or the card and the order history look like they disagree.
    await setDisplayName(env, EMAIL, "Chuy", "member");

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("Chuy");
    expect(body).toContain("Jane Doe");
  });

  it("sends an order number to the order page rather than guessing at a person", async () => {
    const res = await get("/admin/members?q=1001");

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/orders/1001");
  });

  it("says so plainly when a card number matches nothing", async () => {
    const body = await (
      await get("/admin/members?q=LV-00000000-0000-4000-8000-000000000000")
    ).text();

    expect(body).toContain("No membership carries that card number");
  });

  it("says so plainly when an address matches nothing", async () => {
    const body = await (await get("/admin/members?q=nobody@example.com")).text();

    expect(body).toContain("No membership is held under that address");
  });

  it("shows just the search box with nothing typed", async () => {
    const res = await get("/admin/members");

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("No membership");
  });

  it("is admin-only", async () => {
    // `requireAdmin` reads `users.is_admin` rather than trusting the session
    // token's flag, so this needs a different user rather than a different
    // token.
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, ?, 0)")
      .bind("member@example.com")
      .run();

    expect((await get(`/admin/members?q=${CARD}`, 9)).status).toBe(403);
    expect((await get(`/admin/members?q=${CARD}`, null)).status).toBe(302);
  });

  it("is never cached, since it shows names and addresses", async () => {
    const res = await get(`/admin/members?q=${encodeURIComponent(CARD)}`);

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("an admin setting the name on someone's card", () => {
  it("sets a name on their behalf, recorded as the admin's doing", async () => {
    // Matters most for a gifted membership: the card carries the buyer's name
    // until the recipient orders something of their own.
    const res = await post({ email: EMAIL, display_name: "Chuy" });

    expect(res.status).toBe(303);
    expect((await getMemberByEmail(env, EMAIL))!.display_name).toBe("Chuy");
    expect((await getDisplayName(env, EMAIL))?.source).toBe("admin");
  });

  it("records which admin did it, not just that an admin did", async () => {
    // A note nobody can attribute answers half the question. Revocations and
    // bans have said who since they were built; names had not (migration 0019).
    await post({ email: EMAIL, display_name: "Chuy" });

    expect((await getDisplayName(env, EMAIL))?.set_by_email).toBe("admin@example.com");

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();
    expect(body).toContain("admin@example.com");
  });

  it("keeps the reason given, for whoever asks later", async () => {
    await post({ email: EMAIL, display_name: "Chuy", note: "gift from a friend" });

    const row = await env.DB.prepare("SELECT note FROM member_display_names WHERE email = ?")
      .bind(EMAIL)
      .first<{ note: string | null }>();
    expect(row?.note).toBe("gift from a friend");
  });

  it("puts the card back to the derived name when cleared", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "admin");

    const res = await post({ email: EMAIL, action: "clear" });

    expect(res.status).toBe(303);
    expect(cardNameText((await getMemberByEmail(env, EMAIL))!)).toBe("Jane Doe");
  });

  it("says so rather than pretending, when there was no name to clear", async () => {
    const res = await post({ email: EMAIL, action: "clear" });

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("refuses an empty name rather than storing one", async () => {
    const res = await post({ email: EMAIL, display_name: "   " });

    expect(res.headers.get("Location")).toContain("error=");
    expect((await getMemberByEmail(env, EMAIL))!.display_name).toBeNull();
  });

  it("says who set a name, so nobody has to guess", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "legacy_postgres");

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("came across from the previous site");
  });

  it("is admin-only", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, ?, 0)")
      .bind("member@example.com")
      .run();

    expect((await post({ email: EMAIL, display_name: "Chuy" }, 9)).status).toBe(403);
    expect((await getMemberByEmail(env, EMAIL))!.display_name).toBeNull();
  });
});

describe("revoking and expelling from the member page", () => {
  it("offers both actions on somebody in good standing", async () => {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("Revoke this membership");
    expect(body).toContain("Expel this person from the group");
  });

  it("revokes a membership, with the reason kept", async () => {
    const res = await post({ email: EMAIL, action: "revoke", revocation_note: "conduct" });

    expect(res.status).toBe(303);
    expect(await isRevoked(env, CARD)).toBe(true);
    const row = await env.DB.prepare("SELECT note FROM revoked_cards WHERE member_id = ?")
      .bind(CARD)
      .first<{ note: string | null }>();
    expect(row?.note).toBe("conduct");
  });

  it("offers a restore once revoked, and says what state they are in", async () => {
    await revokeCard(env, CARD, null, ADMIN_ID);

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("This membership has been revoked");
    expect(body).toContain("Restore this membership");
    expect(body).not.toContain("Revoke this membership");
  });

  it("restores a revoked membership", async () => {
    await revokeCard(env, CARD, null, ADMIN_ID);

    const res = await post({ email: EMAIL, action: "restore" });

    expect(res.headers.get("Location")).toContain("saved=restored");
    expect(await isRevoked(env, CARD)).toBe(false);
  });

  it("expels a person, with the reason kept", async () => {
    const res = await post({ email: EMAIL, action: "ban", ban_note: "a recorded reason" });

    expect(res.headers.get("Location")).toContain("saved=banned");
    expect(await isBanned(env, EMAIL)).toBe(true);
  });

  it("offers a lift once expelled, and says what state they are in", async () => {
    await banPerson(env, EMAIL, null, ADMIN_ID);

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("expelled from Los Verdes");
    expect(body).toContain("Lift this expulsion");
    expect(body).not.toContain("Expel this person from the group");
  });

  it("lifts a ban", async () => {
    await banPerson(env, EMAIL, null, ADMIN_ID);

    const res = await post({ email: EMAIL, action: "unban" });

    expect(res.headers.get("Location")).toContain("saved=unbanned");
    expect(await isBanned(env, EMAIL)).toBe(false);
  });

  it.each([
    ["restore", "has not been revoked"],
    ["unban", "has not been expelled"],
  ])("says so rather than pretending, when %s has nothing to undo", async (action) => {
    const res = await post({ email: EMAIL, action });

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("will not withdraw or bar an address with no membership", async () => {
    const res = await post({ email: "nobody@example.com", action: "revoke" });

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("shows what just happened", async () => {
    const banned = await (await get("/admin/members?saved=banned")).text();
    expect(banned).toContain("Expelled from the group");
    const lifted = await (await get("/admin/members?saved=unbanned")).text();
    expect(lifted).toContain("Expulsion lifted");
  });
});
