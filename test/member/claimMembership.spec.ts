import "../setup/d1";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE_NAME,
  issueSessionToken,
  verifySessionToken,
} from "../../src/auth/session";
import { SENDGRID_SEND_URL } from "../../src/email/sendgrid";
import worker from "../../src/index";
import {
  CLAIM_TOKEN_TTL_SECONDS,
  issueClaimToken,
  verifyClaimToken,
} from "../../src/member/claimToken";

const ORIGIN = "https://card.losverd.es";
const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const OTHER_USER_ID = 8;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = ORIGIN;
  env.SENDGRID_API_KEY = "SG.test-key";
  env.EMAIL_FROM_ADDRESS = "cards@losverdesatx.org";
  env.EMAIL_FROM_NAME = "Los Verdes";
  await insertUser(USER_ID, "w49snrrxhh@privaterelay.appleid.com");
  await insertUser(OTHER_USER_ID, "someone-else@example.com");
  await insertMember("BC-1", "jane@example.com", "2099-03-04");
  await insertMember("BC-2", "lapsed@example.com", "2020-01-01");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM rate_limit_counters");
});

async function insertUser(id: number, email: string) {
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind(id, email).run();
}

async function insertMember(memberId: string, email: string, expirationDate: string) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status,
                          expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'standard', 'active', ?, '2021-07-15', 'token', 1)`,
  )
    .bind(memberId, email, expirationDate)
    .run();
}

function mockSendGrid(status = 202) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SENDGRID_SEND_URL) {
      return new Response(status === 202 ? null : "nope", { status });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function sentMessages(spy: ReturnType<typeof mockSendGrid>) {
  return spy.mock.calls
    .filter(([input]) => String(input) === SENDGRID_SEND_URL)
    .map(([, init]) => JSON.parse(init!.body as string));
}

async function sessionCookie(userId: number) {
  const token = await issueSessionToken(SESSION_KEY, { userId, isAdmin: false });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function request(
  path: string,
  init: RequestInit = {},
  userId: number | null = USER_ID,
) {
  const headers = new Headers(init.headers);
  if (userId !== null) headers.set("Cookie", await sessionCookie(userId));
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
    env,
    ctx,
  );
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, location: res.headers.get("Location") };
}

async function submit(email: string, userId: number | null = USER_ID) {
  return request(
    "/claim-membership",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams({ email }),
    },
    userId,
  );
}

function confirmUrlFrom(messages: ReturnType<typeof sentMessages>): string {
  const text = messages[0].content[0].value as string;
  const match = text.match(/https:\/\/\S+/);
  if (!match) throw new Error("no link in the claim email");
  return match[0];
}

async function linkedUserFor(memberId: string) {
  const row = await env.DB.prepare("SELECT user_id FROM members WHERE member_id = ?")
    .bind(memberId)
    .first<{ user_id: number | null }>();
  return row?.user_id ?? null;
}

describe("the claim token", () => {
  it("round-trips the member and the user who asked", async () => {
    const token = await issueClaimToken(SESSION_KEY, { userId: 7, memberId: "BC-1" });

    expect(await verifyClaimToken(SESSION_KEY, token)).toEqual({
      userId: 7,
      memberId: "BC-1",
    });
  });

  it.each([
    ["tampered", (t: string) => `${t.slice(0, -2)}xy`],
    ["truncated", (t: string) => t.slice(0, 20)],
    ["empty", () => ""],
    ["not a token at all", () => "hello"],
  ])("rejects a %s token", async (_label, mangle) => {
    const token = await issueClaimToken(SESSION_KEY, { userId: 7, memberId: "BC-1" });

    expect(await verifyClaimToken(SESSION_KEY, mangle(token))).toBeNull();
  });

  it("rejects one signed with a different key", async () => {
    const token = await issueClaimToken("a-completely-different-key-0123456", {
      userId: 7,
      memberId: "BC-1",
    });

    expect(await verifyClaimToken(SESSION_KEY, token)).toBeNull();
  });

  it("expires, so a link left in an inbox stops working", async () => {
    const issuedAt = 1_800_000_000;
    const token = await issueClaimToken(SESSION_KEY, { userId: 7, memberId: "BC-1" }, issuedAt);

    const justInside = issuedAt + CLAIM_TOKEN_TTL_SECONDS - 5;
    const justOutside = issuedAt + CLAIM_TOKEN_TTL_SECONDS + 5;
    expect(await verifyClaimToken(SESSION_KEY, token, justInside)).not.toBeNull();
    expect(await verifyClaimToken(SESSION_KEY, token, justOutside)).toBeNull();
  });

  // The two token kinds are signed with the same key, so nothing but their
  // shape stops one being presented as the other.
  it("cannot be used as a session cookie", async () => {
    const claim = await issueClaimToken(SESSION_KEY, { userId: USER_ID, memberId: "BC-1" });

    expect(await verifySessionToken(SESSION_KEY, claim)).toBeNull();
  });

  it("is not satisfied by a session cookie", async () => {
    const session = await issueSessionToken(SESSION_KEY, { userId: USER_ID, isAdmin: true });

    expect(await verifyClaimToken(SESSION_KEY, session)).toBeNull();
  });

  it.each([
    ["a member but no user", { mid: "BC-1" }],
    ["a user but no member", { uid: 7 }],
    ["a user id that isn't a number", { uid: "7", mid: "BC-1" }],
    ["a fractional user id", { uid: 7.5, mid: "BC-1" }],
    ["an empty member id", { uid: 7, mid: "" }],
    ["a member id that isn't a string", { uid: 7, mid: 1 }],
  ])("rejects a properly signed token carrying %s", async (_label, claims) => {
    // Signature and subject are genuine here -- only the claims are wrong.
    // Nothing but these checks stands between a malformed token and a
    // `UPDATE members SET user_id = undefined`.
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("membership-claim")
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(SESSION_KEY));

    expect(await verifyClaimToken(SESSION_KEY, forged)).toBeNull();
  });

  it("refuses to work at all without a signing key", async () => {
    // Fails loudly rather than signing with the empty string, which would
    // make every claim token forgeable by anyone who noticed.
    await expect(issueClaimToken("", { userId: 7, memberId: "BC-1" })).rejects.toThrow(
      "SESSION_SIGNING_KEY",
    );
    const token = await issueClaimToken(SESSION_KEY, { userId: 7, memberId: "BC-1" });
    await expect(verifyClaimToken("", token)).rejects.toThrow("SESSION_SIGNING_KEY");
  });
});

describe("requesting a claim link", () => {
  it("needs a signed-in visitor", async () => {
    const res = await request("/claim-membership", {}, null);

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/^\/login(\?|$)/);
  });

  it("offers the form to someone signed in", async () => {
    const res = await request("/claim-membership");

    expect(res.status).toBe(200);
    expect(res.body).toContain("Hide My Email");
  });

  it("emails a confirmation link to a current member's address", async () => {
    const fetchSpy = mockSendGrid();

    const res = await submit("jane@example.com");

    expect(res.status).toBe(200);
    const messages = sentMessages(fetchSpy);
    expect(messages).toHaveLength(1);
    expect(messages[0].personalizations[0].to[0].email).toBe("jane@example.com");
    expect(confirmUrlFrom(messages)).toContain("/claim-membership/confirm?token=");
  });

  it("says nothing about the membership in the email", async () => {
    // Someone who types an address they don't own learns only that mail was
    // sent. Naming the member, the tier or the expiry here would undo the
    // anti-enumeration the form in front of it is built for.
    const fetchSpy = mockSendGrid();

    await submit("jane@example.com");

    const body = JSON.stringify(sentMessages(fetchSpy)[0]);
    expect(body).not.toContain("Jane");
    expect(body).not.toContain("BC-1");
    expect(body).not.toContain("2099");
  });

  it("never attaches a card, whatever else it carries", async () => {
    // The standing rule: a membership card is never emailed as a side effect
    // of something else. Proving an address is not asking for a card.
    const fetchSpy = mockSendGrid();

    await submit("jane@example.com");

    expect(sentMessages(fetchSpy)[0].attachments).toBeUndefined();
  });

  it.each([
    ["an address belonging to nobody", "stranger@example.com"],
    ["a lapsed membership", "lapsed@example.com"],
  ])("answers %s exactly as it answers a member", async (_label, email) => {
    const fetchSpy = mockSendGrid();
    const member = await submit("jane@example.com");
    vi.clearAllMocks();

    const other = await submit(email, OTHER_USER_ID);

    expect(other.status).toBe(member.status);
    expect(other.body).toBe(member.body);
    expect(sentMessages(fetchSpy)).toHaveLength(0);
  });

  it("rejects an address that isn't one", async () => {
    const fetchSpy = mockSendGrid();

    const res = await submit("not-an-email");

    expect(res.status).toBe(400);
    expect(sentMessages(fetchSpy)).toHaveLength(0);
  });

  it("rejects a form with no address in it at all", async () => {
    const fetchSpy = mockSendGrid();

    const res = await request(
      "/claim-membership",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: new URLSearchParams({ something: "else" }),
      },
    );

    expect(res.status).toBe(400);
    expect(sentMessages(fetchSpy)).toHaveLength(0);
  });

  it("stops a signed-in visitor sweeping addresses", async () => {
    mockSendGrid();

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await submit(`probe${i}@example.com`)).status);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("stops one address being mailed repeatedly, without saying so", async () => {
    const fetchSpy = mockSendGrid();

    const responses = [];
    for (const userId of [USER_ID, OTHER_USER_ID, USER_ID, OTHER_USER_ID]) {
      responses.push(await submit("jane@example.com", userId));
    }

    // Three sends allowed, the fourth silently dropped -- and every response
    // identical, since the limit is about the inbox, not the visitor.
    expect(sentMessages(fetchSpy)).toHaveLength(3);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
  });

  it("survives SendGrid failing, without telling the visitor anything different", async () => {
    const fetchSpy = mockSendGrid(500);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await submit("jane@example.com");

    expect(res.status).toBe(200);
    expect(sentMessages(fetchSpy)).toHaveLength(1);
    expect(await linkedUserFor("BC-1")).toBeNull();
  });
});

describe("following a claim link", () => {
  async function claimLinkFor(email: string, userId = USER_ID) {
    const fetchSpy = mockSendGrid();
    await submit(email, userId);
    const url = confirmUrlFrom(sentMessages(fetchSpy));
    vi.restoreAllMocks();
    return url.slice(ORIGIN.length);
  }

  it("links the membership and lands on the card", async () => {
    const path = await claimLinkFor("jane@example.com");

    const res = await request(path);

    expect(res.status).toBe(302);
    expect(res.location).toBe("/?claimed=1");
    expect(await linkedUserFor("BC-1")).toBe(USER_ID);
  });

  it("refuses a link opened by a different account", async () => {
    // The reason the token names the user as well as the member: without
    // this, forwarding the email hands the membership to whoever opens it.
    const path = await claimLinkFor("jane@example.com", USER_ID);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(path, {}, OTHER_USER_ID);

    expect(res.status).toBe(403);
    expect(await linkedUserFor("BC-1")).toBeNull();
  });

  it("needs a session as well as the link", async () => {
    const path = await claimLinkFor("jane@example.com");

    const res = await request(path, {}, null);

    expect(res.status).toBe(302);
    expect(await linkedUserFor("BC-1")).toBeNull();
  });

  it.each([
    ["a token that never was", "/claim-membership/confirm?token=nonsense"],
    ["no token at all", "/claim-membership/confirm"],
  ])("turns away %s", async (_label, path) => {
    const res = await request(path);

    expect(res.status).toBe(400);
    expect(res.body).toContain("30 minutes");
  });

  it("can be followed twice without complaining", async () => {
    // A mail client that prefetches links, or a member who taps twice,
    // should land on their card rather than an error.
    const path = await claimLinkFor("jane@example.com");

    expect((await request(path)).status).toBe(302);
    const second = await request(path);

    expect(second.status).toBe(302);
    expect(second.location).toBe("/?claimed=1");
    expect(await linkedUserFor("BC-1")).toBe(USER_ID);
  });

  it("won't take a membership already claimed by someone else", async () => {
    const path = await claimLinkFor("jane@example.com", USER_ID);
    await env.DB.prepare("UPDATE members SET user_id = ? WHERE member_id = 'BC-1'")
      .bind(OTHER_USER_ID)
      .run();

    const res = await request(path);

    expect(res.status).toBe(409);
    expect(await linkedUserFor("BC-1")).toBe(OTHER_USER_ID);
  });

  it("gets the member to their card, which is the point of all this", async () => {
    // End to end: a relay-address login that had no membership now has one.
    const before = await request("/");
    expect(before.location).toBe("/no-active-membership");

    await request(await claimLinkFor("jane@example.com"));

    const after = await request("/");
    expect(after.status).toBe(200);
    expect(after.body).toContain("Jane Doe");
  });
});

describe("the way in", () => {
  it("is offered on the no-membership page", async () => {
    const res = await request("/no-active-membership");

    expect(res.body).toContain('href="/claim-membership"');
  });
});
