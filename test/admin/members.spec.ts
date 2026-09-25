import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { NAME_SEARCH_LIMIT, classify, parseNameSearch } from "../../src/admin/members";
import { getDisplayName, setDisplayName } from "../../src/member/displayName";
import { isExpelled, expelPerson } from "../../src/member/expulsion";
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
    `INSERT INTO members (member_id, first_name, last_name, email,
       expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, '2099-03-04', '2021-07-15', 'token', 1)`,
  )
    .bind(CARD, EMAIL)
    .run();
});

afterEach(async () => {
  // Before `members`: both reference it, and D1 enforces the constraint, so
  // the delete fails and the next test's fixtures collide with what is left.
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM slack_users");
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

    expect(body).toContain("No membership is held under that address, and no orders either");
  });

  it("says so for something that is not an address at all, without looking anything up", async () => {
    const body = await (await get("/admin/members?q=not%20an%40address")).text();

    expect(body).toContain("No membership is held under that address, and no orders either");
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

describe("working out what was typed into the name form", () => {
  it.each([
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    ["j", { kind: "too-short" }],
    ["@j", { kind: "too-short" }],
    ["@", { kind: "too-short" }],
    ["  Doe ", { kind: "name", value: "Doe" }],
    ["jane doe", { kind: "name", value: "jane doe" }],
    ["@janed", { kind: "slack-handle", value: "janed" }],
    ["@ janed ", { kind: "slack-handle", value: "janed" }],
  ])("%j", (typed, expected) => {
    expect(parseNameSearch(typed)).toEqual(expected);
  });
});

describe("finding members by name or Slack handle", () => {
  const OTHER_CARD = "LV-6f1c8e40-0000-4000-8000-000000000002";

  async function insertMember(memberId: string, first: string, last: string, email: string) {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email,
         expiration_date, member_since, auth_token, last_updated_at)
       VALUES (?, ?, ?, ?, '2099-03-04', '2021-07-15', 'token', 1)`,
    )
      .bind(memberId, first, last, email)
      .run();
  }

  async function insertSlack(email: string, name: string, realName: string, displayName: string, deleted = 0) {
    await env.DB.prepare(
      `INSERT INTO slack_users (slack_id, name, real_name, email, deleted, profile, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(`U${name}`, name, realName, email, deleted, JSON.stringify({ display_name: displayName }))
      .run();
  }

  const memberLink = `<a href="/admin/members?q=${encodeURIComponent(CARD)}">`;

  it("finds somebody by part of the name on their orders, whatever the case", async () => {
    await insertMember(OTHER_CARD, "Rosa", "Verde", "rosa@example.com");

    const body = await (await get("/admin/members?name=DOE")).text();

    expect(body).toContain("1 person matches.");
    expect(body).toContain(`${memberLink}Jane Doe</a>`);
    expect(body).toContain("jane@example.com");
    expect(body).not.toContain("rosa@example.com");
  });

  it("lists everybody who matches, by surname", async () => {
    await insertMember(OTHER_CARD, "Janet", "Brown", "janet@example.com");

    const body = await (await get("/admin/members?name=jane")).text();

    expect(body).toContain("2 people match.");
    expect(body.indexOf("janet@example.com")).toBeLessThan(body.indexOf("jane@example.com"));
  });

  it("matches across first and last name", async () => {
    const body = await (await get("/admin/members?name=jane%20d")).text();

    expect(body).toContain(`${memberLink}Jane Doe</a>`);
  });

  it("finds somebody by the name on their card, and lists them under it", async () => {
    await setDisplayName(env, EMAIL, "Juana Verde", "member", null, null);

    const body = await (await get("/admin/members?name=juana")).text();

    expect(body).toContain(`${memberLink}Juana Verde</a>`);
  });

  it("finds somebody by their Slack name, and shows their handle", async () => {
    await insertSlack(EMAIL, "jdoe", "Janie Q", "janie");

    const body = await (await get("/admin/members?name=janie%20q")).text();

    expect(body).toContain(`${memberLink}Jane Doe</a>`);
    expect(body).toContain("@janie");
  });

  it("finds somebody by Slack handle, whether the current one or the legacy username", async () => {
    await insertSlack(EMAIL, "jdoe", "Jane Doe", "janie");

    expect(await (await get("/admin/members?name=%40jan")).text()).toContain(`${memberLink}Jane Doe</a>`);
    expect(await (await get("/admin/members?name=%40jdo")).text()).toContain(`${memberLink}Jane Doe</a>`);
  });

  it("falls back to the legacy username when a Slack account has no display name", async () => {
    await insertSlack(EMAIL, "jdoe", "Jane Doe", "");

    expect(await (await get("/admin/members?name=jane")).text()).toContain("@jdoe");
  });

  it("matches only Slack handles when an @handle is typed", async () => {
    await insertSlack(EMAIL, "jdoe", "Jane Doe", "jd");

    const body = await (await get("/admin/members?name=%40jane")).text();

    expect(body).not.toContain(memberLink);
    expect(body).toContain("Nobody with a membership has a Slack handle containing that.");
  });

  it("takes % and _ literally rather than as wildcards", async () => {
    const body = await (await get(`/admin/members?name=${encodeURIComponent("J%e")}`)).text();

    expect(body).not.toContain(memberLink);
    expect(body).toContain("Nobody with a membership has a name or Slack handle containing that.");
  });

  it("asks for more letters rather than listing everybody", async () => {
    const body = await (await get("/admin/members?name=j")).text();

    expect(body).toContain("Type at least 2 letters of a name.");
    expect(body).not.toContain(memberLink);
  });

  it("says who is revoked or expelled, as the member page would", async () => {
    await revokeCard(env, CARD, null, ADMIN_ID);

    const body = await (await get("/admin/members?name=doe")).text();

    expect(body).toContain("revoked or expelled");
    expect(body).not.toContain("Mar 4, 2099");
  });

  it("says when a member has no counted orders", async () => {
    await env.DB.prepare("UPDATE members SET expiration_date = NULL WHERE member_id = ?").bind(CARD).run();

    expect(await (await get("/admin/members?name=doe")).text()).toContain("no counted orders");
  });

  it("stops at a readable number and says there were more", async () => {
    // Padded, so they sort in number order and the one left off is the last.
    const n = (i: number) => String(i).padStart(2, "0");
    for (let i = 0; i <= NAME_SEARCH_LIMIT; i++) {
      await insertMember(`LV-00000000-0000-4000-8000-0000000000${n(i)}`, "Rosa", `Verde${n(i)}`, `rosa${n(i)}@example.com`);
    }

    const body = await (await get("/admin/members?name=rosa")).text();

    expect(body).toContain(`More than ${NAME_SEARCH_LIMIT} people match`);
    expect(body.split(">Rosa Verde").length - 1).toBe(NAME_SEARCH_LIMIT);
    expect(body).not.toContain(`rosa${n(NAME_SEARCH_LIMIT)}@example.com`);
  });

  it("offers both forms, keeping what was typed in each", async () => {
    const body = await (await get("/admin/members?name=doe")).text();

    expect(body).toContain('<input id="q" name="q" type="text" value=""');
    expect(body).toContain('<input id="name" name="name" type="text" value="doe"');
  });
});

describe("an address with orders and no membership", () => {
  // The state #241 is about. Real after a refund or a re-attribution, and the
  // state of almost every address between the one-time import and the first
  // full resync.
  async function insertOrder(
    orderId: string,
    orderEmail: string,
    memberEmail: string,
    status: string,
  ) {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status,
         product_name, created_on, expires_on, first_seen_via)
       VALUES (?, 'bigcommerce', ?, ?, ?, 'Annual Membership', '2026-03-01T10:00:00Z',
         '2027-03-01T10:00:00Z', 'legacy_postgres')`,
    )
      .bind(orderId, orderEmail, memberEmail, status)
      .run();
  }

  it("shows the orders and why none of them makes a membership", async () => {
    await insertOrder("1001", "sam.rivera@example.com", "sam.rivera@example.com", "Refunded");

    const body = await (await get("/admin/members?q=sam.rivera@example.com")).text();

    expect(body).toContain("No membership is held under this address");
    expect(body).toContain("Orders attributed to it: 1");
    expect(body).toContain("membership: 0");
    expect(body).toContain("None of them counts");
    expect(body).toContain('href="/admin/orders/1001"');
    expect(body).toContain("Refunded");
    // Not the dead-end message, and none of the actions that need a member.
    expect(body).not.toContain("no orders either");
    expect(body).not.toContain("Revoke this membership");
  });

  it("says the membership has not been built yet when an order does count", async () => {
    await insertOrder("1002", "sam.rivera@example.com", "sam.rivera@example.com", "Shipped");

    const body = await (await get("/admin/members?q=Sam.Rivera@example.com")).text();

    expect(body).toContain("membership: 1");
    expect(body).toContain("has not been built");
    expect(body).not.toContain("None of them counts");
  });

  it("shows an order placed with the address and since pointed at somebody else", async () => {
    await insertOrder("1003", "sam.rivera@example.com", "alex.chen@example.com", "Shipped");

    const body = await (await get("/admin/members?q=sam.rivera@example.com")).text();

    expect(body).toContain("since pointed at somebody else");
    expect(body).toContain('href="/admin/orders/1003"');
    expect(body).toContain("/admin/members?q=alex.chen%40example.com");
    // Nothing is attributed here any more, so neither explanation applies.
    expect(body).toContain("Orders attributed to it: 0");
    expect(body).not.toContain("None of them counts");
    expect(body).not.toContain("has not been built");
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
    // expulsions have said who since they were built; names had not.
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
    const res = await post({ email: EMAIL, action: "expel", expulsion_note: "a recorded reason" });

    expect(res.headers.get("Location")).toContain("saved=expelled");
    expect(await isExpelled(env, EMAIL)).toBe(true);
  });

  it("offers a lift once expelled, and says what state they are in", async () => {
    await expelPerson(env, EMAIL, null, ADMIN_ID);

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("expelled from Los Verdes");
    expect(body).toContain("Lift this expulsion");
    expect(body).not.toContain("Expel this person from the group");
  });

  it("lifts an expulsion", async () => {
    await expelPerson(env, EMAIL, null, ADMIN_ID);

    const res = await post({ email: EMAIL, action: "readmit" });

    expect(res.headers.get("Location")).toContain("saved=readmitted");
    expect(await isExpelled(env, EMAIL)).toBe(false);
  });

  it.each([
    ["restore", "has not been revoked"],
    ["readmit", "has not been expelled"],
  ])("says so rather than pretending, when %s has nothing to undo", async (action) => {
    const res = await post({ email: EMAIL, action });

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("will not withdraw or bar an address with no membership", async () => {
    const res = await post({ email: "nobody@example.com", action: "revoke" });

    expect(res.headers.get("Location")).toContain("error=");
  });

  it("shows what just happened", async () => {
    const expelled = await (await get("/admin/members?saved=expelled")).text();
    expect(expelled).toContain("Expelled from the group");
    const lifted = await (await get("/admin/members?saved=readmitted")).text();
    expect(lifted).toContain("Expulsion lifted");
  });
});
