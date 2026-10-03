import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { SEASONAL_THEMES } from "../../src/themes/cardTheme";
import { NAME_SEARCH_LIMIT, classify, parseNameSearch } from "../../src/admin/members";
import { getDisplayName, setDisplayName } from "../../src/member/displayName";
import { isExpelled, expelPerson } from "../../src/member/expulsion";
import { isRevoked, revokeCard } from "../../src/member/revocation";
import { cardNameText, getMemberByEmail, renderCardImage } from "../../src/member/artifacts";
import { YEAR_THEMES } from "../../src/themes/cardTheme";
import { getCardThemeChoice, setCardTheme } from "../../src/themes/choice";
import { linkStoreAccount } from "../../src/bigcommerce/storeAccount";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";

// Stated, not inherited: wrangler.toml switches year themes by default and
// Apple's poster layout per environment, and these tests are about cards with
// neither unless they say so.
const configuredSwitches = { years: env.CARD_THEME_YEAR_DEFAULTS, posters: env.APPLE_POSTER_PASSES };
beforeEach(() => {
  env.CARD_THEME_YEAR_DEFAULTS = "false";
  env.APPLE_POSTER_PASSES = "off";
});
afterEach(() => {
  env.CARD_THEME_YEAR_DEFAULTS = configuredSwitches.years;
  env.APPLE_POSTER_PASSES = configuredSwitches.posters;
});

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
  await env.DB.exec("DELETE FROM member_card_themes");
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
    const body = await res.text();
    expect(body).not.toContain("No membership");
    expect(body).toContain("<h1>Find a member</h1>");
    expect(body).not.toContain("Find someone else");
  });

  it("is headed with whose page it is, details first and the search after", async () => {
    // Links from the reports land here; the heading is what says so.
    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("<title>Member: Jane Doe | Los Verdes Admin</title>");
    expect(body).toContain("<h1>Member: Jane Doe</h1>");
    expect(body.indexOf("Card #")).toBeLessThan(body.indexOf("<h2>Find someone else</h2>"));
    expect(body.indexOf("<h2>Find someone else</h2>")).toBeLessThan(body.indexOf('<input id="q"'));
  });

  it("heads the page with the name on their card, if they chose one", async () => {
    await setDisplayName(env, EMAIL, "Juana Verde", "member", null, null);

    expect(await (await get(`/admin/members?q=${EMAIL}`)).text()).toContain("<h1>Member: Juana Verde</h1>");
  });

  it("falls back to the address in the heading when there is no name at all", async () => {
    await env.DB.prepare("UPDATE members SET first_name = '', last_name = '' WHERE member_id = ?").bind(CARD).run();

    expect(await (await get(`/admin/members?q=${EMAIL}`)).text()).toContain(`<h1>Member: ${EMAIL}</h1>`);
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

  it("is headed with the address, not as a search page", async () => {
    await insertOrder("1001", "sam.rivera@example.com", "sam.rivera@example.com", "Refunded");

    const body = await (await get("/admin/members?q=sam.rivera@example.com")).text();

    expect(body).toContain("<h1>Address: sam.rivera@example.com</h1>");
    expect(body).toContain("<h2>Find someone else</h2>");
  });

  it("shows the orders and why none of them makes a membership", async () => {
    await insertOrder("1001", "sam.rivera@example.com", "sam.rivera@example.com", "Refunded");

    const body = await (await get("/admin/members?q=sam.rivera@example.com")).text();

    expect(body).toContain("No membership is held under this address");
    expect(body).toContain("Orders attributed to it: 1");
    expect(body).not.toContain("A member: one person");
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

  it("asks once more before revoking, saying what it does, with the reason carried over", async () => {
    const res = await post({ email: EMAIL, action: "revoke", revocation_note: "conduct" });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(await isRevoked(env, CARD)).toBe(false);
    expect(body).toContain("Revoke this membership?");
    expect(body).toContain("stops counting as current");
    expect(body).toContain('name="confirmed" value="1"');
    expect(body).toContain('value="conduct"');
    expect(body).toContain(`href="/admin/members?q=jane%40example.com">Cancel</a>`);
  });

  it("asks once more before expelling, too", async () => {
    const res = await post({ email: EMAIL, action: "expel", expulsion_note: "a recorded reason" });

    expect(res.status).toBe(200);
    expect(await isExpelled(env, EMAIL)).toBe(false);
    expect(await res.text()).toContain("can no longer sign in here");
  });

  it("puts both behind a disclosure on the member page, in the danger colour", async () => {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body.match(/<details class="danger-zone">/g)).toHaveLength(2);
    expect(body).toContain('<button type="submit" class="danger">Revoke this membership</button>');
    expect(body).not.toContain('name="confirmed"');
  });

  it("revokes a membership, with the reason kept", async () => {
    const res = await post({ email: EMAIL, action: "revoke", revocation_note: "conduct", confirmed: "1" });

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
    const res = await post({ email: EMAIL, action: "expel", expulsion_note: "a recorded reason", confirmed: "1" });

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

describe("their Slack account on the member page", () => {
  async function slack(name: string | null, displayName: string | null, deleted = 0) {
    await env.DB.prepare(
      `INSERT INTO slack_users (slack_id, name, real_name, email, deleted, profile, synced_at)
       VALUES ('U0SLACK', ?, 'Jane Doe', ?, ?, ?, 0)`,
    )
      .bind(name, EMAIL, deleted, displayName === null ? null : JSON.stringify({ display_name: displayName }))
      .run();
  }

  async function slackCell() {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();
    return body.match(/<th[^>]*>Slack<\/th><td[^>]*>([^<]*)<\/td>/)?.[1];
  }

  it("shows the handle Slack shows today", async () => {
    await slack("jdoe", "janie");

    expect(await slackCell()).toBe("@janie");
  });

  it("falls back to the legacy username when no display name was set", async () => {
    await slack("jdoe", "");

    expect(await slackCell()).toBe("@jdoe");
  });

  it("says a matched account has no handle rather than inventing one", async () => {
    await slack(null, null);

    expect(await slackCell()).toBe("matched");
  });

  it("says when the account has been deactivated", async () => {
    await slack("jdoe", "janie", 1);

    expect(await slackCell()).toBe("@janie (account deactivated)");
  });

  it("says when there is no Slack account for the address", async () => {
    expect(await slackCell()).toBe("no match");
  });

  it("shows the handle for an address with orders and no membership too", async () => {
    await env.DB.exec("DELETE FROM members");
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES ('1001', 'bigcommerce', ?1, ?1, 'Refunded', '2026-03-01T10:00:00Z', '2027-03-01T10:00:00Z', 'sync')`,
    )
      .bind(EMAIL)
      .run();
    await slack("jdoe", "janie");

    expect(await (await get(`/admin/members?q=${EMAIL}`)).text()).toContain("Slack: @janie.");
  });
});

describe("their card, on their page", () => {
  beforeEach(() => {
    env.PASS_SIGNATURE_KEY = "test-pass-signature-key-0123456789";
  });

  it("says under its title that a member is one person, with their card worked out from every order", async () => {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`)).text();
    const intro = body.indexOf("A member: one person in Los Verdes, and the card they carry.");

    expect(intro).toBeGreaterThan(body.indexOf("<h1>"));
    expect(intro).toBeLessThan(body.indexOf("Their card as it looks to them now."));
    expect(await (await get("/admin/members")).text()).not.toContain("A member: one person");
  });

  it("shows the card beside their details, fetched by card number rather than address", async () => {
    const body = await (await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`)).text();

    expect(body).toContain(`<img src="/admin/members/card.png?id=${encodeURIComponent(CARD)}"`);
    expect(body).toContain('alt="Jane Doe&#39;s membership card"');
    expect(body).toContain("Their card as it looks to them now.");
    expect(body).not.toMatch(/card\.png\?[^"]*%40/);
  });

  it("says so when their membership is revoked and they cannot open the card themselves", async () => {
    await revokeCard(env, CARD, "conduct", ADMIN_ID);

    const body = await (await get(`/admin/members?q=${encodeURIComponent(CARD)}`)).text();

    expect(body).toContain("Their membership is revoked, so they cannot open it themselves.");
  });

  it("draws the same card their own card page draws, uncached, without counting as them viewing it", async () => {
    const outcomes = spyOnOutcomes();

    const res = await get(`/admin/members/card.png?id=${encodeURIComponent(CARD)}`);
    const png = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png).toEqual(await renderCardImage(env, (await getMemberByEmail(env, EMAIL))!));
    expect(outcomesFrom(outcomes)).toEqual([]);
  });

  it("answers an unknown card number with a 404", async () => {
    expect((await get("/admin/members/card.png?id=LV-00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get("/admin/members/card.png")).status).toBe(404);
  });

  it("is for admins only", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (9, 'member@example.com', 0)").run();

    expect((await get(`/admin/members/card.png?id=${encodeURIComponent(CARD)}`, 9)).status).toBe(403);
    expect((await get(`/admin/members/card.png?id=${encodeURIComponent(CARD)}`, null)).status).toBe(302);
  });
});

describe("their card's theme, on their page", () => {
  // Jane has been a member since 2021, so 2021's theme is hers; 2022's is not.
  const Y2021 = YEAR_THEMES.find((theme) => theme.year === 2021)!;
  const page = async () => (await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`)).text();
  const errorOf = (res: Response) => new URL(res.headers.get("Location")!, "https://card.losverd.es").searchParams.get("error");

  beforeEach(async () => {
    env.PASS_SIGNATURE_KEY = "test-pass-signature-key-0123456789";
  });

  afterEach(async () => {
    env.CARD_THEME_CHOICE = "admins";
  });

  it("says what their card is drawn in and why, and offers only the themes they may use", async () => {
    const body = await page();

    expect(body).toContain("Drawn in <strong>Classic</strong>, their default, as nobody has chosen one.");
    // Seasonal themes are everyone's, so they follow.
    expect(body).toContain(`They may use ${["Classic", "2021: Inaugural season", ...SEASONAL_THEMES.map((theme) => theme.label)].join(", ")}.`);
    expect(body).toContain('<option value="2021">2021: Inaugural season</option>');
    expect(body).not.toContain('value="2022"');
  });

  it("sets a theme for them, saying an admin chose it and which", async () => {
    const res = await post({ email: EMAIL, action: "theme", theme: "2021" });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("saved=theme");
    expect(await getCardThemeChoice(env, EMAIL)).toMatchObject({ theme_id: "2021", source: "admin", set_by_email: "admin@example.com" });
    const body = await page();
    expect(body).toContain("Drawn in <strong>2021: Inaugural season</strong>, which an admin chose for them (admin@example.com).");
    expect(body).toContain('<option value="2021" selected="">');
  });

  it("says when they chose it themselves", async () => {
    await setCardTheme(env, (await getMemberByEmail(env, EMAIL))!, "2021", "member", null);

    expect(await page()).toContain("which they chose themselves.");
  });

  it("says when the theme they chose is no longer one they can use, and that the default is drawn instead", async () => {
    // As after a refund of the only order in that year.
    await env.DB.prepare("INSERT INTO member_card_themes (email, theme_id, source) VALUES (?, '2022', 'member')").bind(EMAIL).run();

    expect(await page()).toContain(
      "Drawn in <strong>Classic</strong>, their default: &quot;2022: Verde hasta la muerte&quot; was chosen, but it is not one they can use any more.",
    );
  });

  it("refuses a theme they may not use, and stores nothing", async () => {
    const res = await post({ email: EMAIL, action: "theme", theme: "2022" });

    expect(errorOf(res)).toBe("That is not a theme their card can use.");
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });

  it("clears a choice, putting their card back to its default", async () => {
    await post({ email: EMAIL, action: "theme", theme: "2021" });

    const res = await post({ email: EMAIL, action: "theme-clear" });

    expect(res.headers.get("Location")).toContain("saved=theme-cleared");
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });

  it("offers nothing to change, and changes nothing, while choosing is switched off", async () => {
    env.CARD_THEME_CHOICE = "off";

    expect(await page()).toContain("Choosing a theme is switched off");
    const res = await post({ email: EMAIL, action: "theme", theme: "2021" });
    expect(errorOf(res)).toBe("Choosing a theme is switched off.");
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });

  it("answers for an address with no membership", async () => {
    const res = await post({ email: "nobody@example.com", action: "theme", theme: "classic" });

    expect(errorOf(res)).toBe("No membership is held under that address.");
  });

  it("previews their card in a theme they may use, and in no other", async () => {
    const member = (await getMemberByEmail(env, EMAIL))!;

    const res = await get(`/admin/members/card.png?id=${encodeURIComponent(CARD)}&theme=2021`);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(await renderCardImage(env, member, Y2021));
    expect((await get(`/admin/members/card.png?id=${encodeURIComponent(CARD)}&theme=2022`)).status).toBe(404);
  });
});

describe("their store account, on their page", () => {
  afterEach(async () => {
    await env.DB.exec("DELETE FROM audit_log");
  });

  const page = async () => (await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`)).text();

  it("says when they have no account here to connect one to", async () => {
    expect(await page()).toMatch(/Store account<\/th><td[^>]*>no account here yet/);
  });

  it("shows the connected account, and lets an admin disconnect it, on the record", async () => {
    await env.DB.prepare("INSERT INTO users (id, email) VALUES (5, ?)").bind(EMAIL).run();
    await linkStoreAccount(env, 5, 4242, 5);

    // The customer links to the store's own control panel.
    expect(await page()).toContain(
      '<a href="https://store-3nco2w7eup.mybigcommerce.com/manage/customers/4242/edit" target="_blank" rel="noopener noreferrer" title="This customer in BigCommerce">Customer 4242 ↗</a>, connected ',
    );
    const res = await post({ email: EMAIL, action: "store-unlink", user_id: "5" });

    expect(res.headers.get("Location")).toContain("saved=store-unlinked");
    expect(await page()).toMatch(/Store account<\/th><td[^>]*>not connected/);
    const { results } = await env.DB.prepare("SELECT action, actor_email FROM audit_log").all();
    expect(results).toContainEqual({ action: "store_account.unlinked", actor_email: "admin@example.com" });
  });

  it("says so when there was nothing to disconnect", async () => {
    const res = await post({ email: EMAIL, action: "store-unlink", user_id: "999" });

    expect(new URL(res.headers.get("Location")!, "https://card.losverd.es").searchParams.get("error")).toBe(
      "There was no store account to disconnect.",
    );
  });
});

describe("their renewal, on their page (#397)", () => {
  const page = async () => (await get(`/admin/members?q=${encodeURIComponent(EMAIL)}`)).text();

  beforeEach(() => {
    env.MINIBC_API_KEY = "test-minibc-key";
  });

  afterEach(async () => {
    env.MINIBC_API_KEY = undefined;
    await env.DB.exec("DELETE FROM minibc_subscriptions");
  });

  async function subscribe(status: string, next: string | null, cancelled: string | null = null) {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES ('5005', 'bigcommerce', ?1, ?1, 'Completed', '2026-02-14T00:00:00Z', '2027-02-14T00:00:00Z', 'sync')`,
    )
      .bind(EMAIL)
      .run();
    await env.DB.prepare(
      `INSERT INTO minibc_subscriptions (subscription_id, order_id, sku, status, next_payment_on, cancelled_on, seen_at)
       VALUES (61, 5005, 'LOSV-MEM-0001', ?, ?, ?, 1)`,
    )
      .bind(status, next, cancelled)
      .run();
  }

  it("says when MiniBC doesn't renew them, and nothing at all where MiniBC isn't read", async () => {
    expect(await page()).toMatch(/Renewal<\/th><td[^>]*>Doesn&#39;t renew automatically/);

    env.MINIBC_API_KEY = undefined;
    expect(await page()).not.toContain("Renewal</th>");
  });

  it("adds a subscription only their address points to, labelled as such, after their own (#470)", async () => {
    await env.DB.prepare(
      `INSERT INTO minibc_subscriptions (subscription_id, order_id, store_customer_id, customer_email, sku, status, next_payment_on, seen_at)
       VALUES (62, 9996, NULL, ?, 'LOSV-MEM-0001', 'active', '2027-03-01', 1)`,
    )
      .bind(EMAIL)
      .run();

    const body = await page();

    expect(body).toMatch(/Renewal<\/th><td[^>]*><div>Doesn&#39;t renew automatically<\/div><div><span class="muted">By address only, no order ties it to them: <\/span>Renews automatically on Mar 1, 2027/);
    expect(body).toContain("(MiniBC subscription 62, a guest checkout)");
  });

  it("says when their card renews, and which subscription says so", async () => {
    await env.DB.prepare("UPDATE members SET expiration_date = '2099-02-14' WHERE email = ?").bind(EMAIL).run();
    await subscribe("active", "2099-02-14");

    const body = await page();
    expect(body).toContain("Renews automatically on Feb 14, 2099");
    expect(body).toContain("(MiniBC subscription 61)");
    expect(body).not.toMatch(/color: var\(--danger\)"[^>]*>Renews automatically/);
  });

  it("flags a card that ran out while its renewal is still on", async () => {
    await env.DB.prepare("UPDATE members SET expiration_date = '2020-02-14' WHERE email = ?").bind(EMAIL).run();
    await subscribe("active", "2099-03-01");

    expect(await page()).toMatch(/color: var\(--danger\)">Membership card ran out on Feb 14, 2020, but automatic renewal is still on/);
  });

  it("says when they cancelled", async () => {
    await subscribe("inactive", null, "2026-06-01");
    expect(await page()).toContain("Automatic renewal cancelled on Jun 1, 2026");
  });
});
