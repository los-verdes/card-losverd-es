import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { banPerson, bannedPeople, isBanned, isUserBanned, liftBan } from "../../src/member/ban";
import { revokeCard, restoreCard } from "../../src/member/revocation";
import { getMemberByEmail, isMembershipCurrent } from "../../src/member/artifacts";
import { lookupPassHolder } from "../../src/member/passHolder";
import { activeMemberships } from "../../src/admin/reportQueries";

const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const CARD = "LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6";
const EMAIL = "jane@example.com";
const TODAY = "2026-06-01";

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .bind(USER_ID, EMAIL)
    .run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status,
       expiration_date, member_since, user_id, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'standard', 'active', '2099-03-04', '2021-07-15', ?, 'token', 1)`,
  )
    .bind(CARD, EMAIL, USER_ID)
    .run();
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name,
       last_name, sku, status, created_on, expires_on, first_seen_via)
     VALUES ('9001_bc', 'bigcommerce', ?, ?, 'Jane', 'Doe', 'LOSV-MEM-0001', 'Completed',
       '2026-01-15T00:00:00Z', '2099-01-15T00:00:00Z', 'sync')`,
  )
    .bind(EMAIL, EMAIL)
    .run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM banned_people");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function getAs(path: string, userId: number | null = USER_ID) {
  const headers = new Headers();
  if (userId !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId, isAdmin: false });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

describe("barring somebody from the group", () => {
  it("takes their membership away, like a withdrawn card does", async () => {
    await banPerson(env, EMAIL, "conduct", null);

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(member.status).toBe("revoked");
    expect(member.expiration_date).toBeNull();
    expect(isMembershipCurrent(member, TODAY)).toBe(false);
  });

  it("stops a session they already hold, not just the next sign-in", async () => {
    // A ban that waited for the next sign-in would leave somebody inside for
    // as long as their session lasted, which is the opposite of the point.
    expect((await getAs("/")).status).toBe(200);

    await banPerson(env, EMAIL, null, null);

    const res = await getAs("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("account-blocked");
  });

  it("tells them it is a decision rather than a fault", async () => {
    // The generic "that sign-in didn't complete, try again" invites exactly
    // the wrong thing from somebody who has been barred.
    const body = await (await getAs("/login?error=account-blocked", null)).text();

    expect(body).toContain("cannot sign in");
    expect(body).toContain("Membership Committee");
    expect(body).not.toContain("Trying again often works");
  });

  it("lifts cleanly, putting the membership back", async () => {
    await banPerson(env, EMAIL, null, null);
    await liftBan(env, EMAIL);

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(member.status).toBe("active");
    expect(member.expiration_date).toBe("2099-03-04");
    expect((await getAs("/")).status).toBe(200);
  });

  it("leaves a separate card withdrawal standing when the ban is lifted", async () => {
    // Two independent decisions. Resolving a ban into `revoked` rather than
    // writing a revocation row is what keeps them independent.
    await revokeCard(env, CARD, "a separate matter", null);
    await banPerson(env, EMAIL, null, null);

    await liftBan(env, EMAIL);

    expect((await getMemberByEmail(env, EMAIL))!.status).toBe("revoked");
    await restoreCard(env, CARD);
    expect((await getMemberByEmail(env, EMAIL))!.status).toBe("active");
  });

  it("says a scanned card is not valid", async () => {
    await banPerson(env, EMAIL, null, null);

    const holder = (await lookupPassHolder(env, CARD, TODAY))!;
    expect(holder.active).toBe(false);
    expect(holder.revoked).toBe(true);
  });

  it("stops them being listed as a current member", async () => {
    expect((await activeMemberships(env.DB, "2026-06-01")).totalMembers).toBe(1);

    await banPerson(env, EMAIL, null, null);

    expect((await activeMemberships(env.DB, "2026-06-01")).totalMembers).toBe(0);
  });

  it("refuses to email a card to somebody barred", async () => {
    // Falls out of resolving the ban in one place rather than being handled
    // here, which is the point of resolving it there.
    await banPerson(env, EMAIL, null, null);

    const member = await getMemberByEmail(env, EMAIL);
    expect(isMembershipCurrent(member!)).toBe(false);
  });

  it("does not restamp a ban already recorded", async () => {
    await banPerson(env, EMAIL, "the original reason", null);

    expect(await banPerson(env, EMAIL, "a later hand", null)).toBe(false);
    expect((await bannedPeople(env))[0].note).toBe("the original reason");
  });

  it("can bar somebody who has never bought anything", async () => {
    // A ban is about a person, not a membership. It applies if they buy one
    // later under the same address.
    expect(await banPerson(env, "stranger@example.com", null, null)).toBe(true);
    expect(await isBanned(env, "stranger@example.com")).toBe(true);
    expect((await bannedPeople(env))[0].has_membership).toBeFalsy();
  });

  it("matches the address whatever case it was typed in", async () => {
    await banPerson(env, "  Jane@Example.com  ", null, null);

    expect(await isBanned(env, EMAIL)).toBe(true);
    expect(await isUserBanned(env, USER_ID)).toBe(true);
  });

  it("says so rather than pretending, when there is no ban to lift", async () => {
    expect(await liftBan(env, EMAIL)).toBe(false);
  });
});
