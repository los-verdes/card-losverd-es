import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { cardName, cardNameText, getMemberByEmail } from "../../src/member/artifacts";
import {
  clearDisplayName,
  normalizeDisplayName,
  setDisplayName,
} from "../../src/member/displayName";
import { refreshMemberFromOrders } from "../../src/bigcommerce/sync";

const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const EMAIL = "jane@example.com";

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .bind(USER_ID, EMAIL)
    .run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status,
       expiration_date, member_since, user_id, auth_token, last_updated_at)
     VALUES ('LV-1', 'Jane', 'Doe', ?, 'active', '2099-03-04', '2021-07-15', ?, 'token', 1)`,
  )
    .bind(EMAIL, USER_ID)
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM member_display_names");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function request(path: string, init: RequestInit = {}) {
  const token = await issueSessionToken(SESSION_KEY, { userId: USER_ID, isAdmin: false });
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  if (init.method === "POST") headers.set("Origin", "https://card.losverd.es");
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, {
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

describe("which name a card shows", () => {
  it("uses the name from the member's orders when nobody has set one", async () => {
    const member = (await getMemberByEmail(env, EMAIL))!;

    expect(cardNameText(member)).toBe("Jane Doe");
  });

  it("prefers a display name once one is set", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "member");

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(cardNameText(member)).toBe("Chuy");
  });

  it("puts a whole display name in the first-name slot, leaving the last empty", () => {
    // A name somebody chose is not ours to split, and plenty of them would
    // not survive being split. Renderers join the two and trim.
    expect(cardName({ display_name: "Chuy", first_name: "Jane", last_name: "Doe" })).toEqual({
      firstName: "Chuy",
      lastName: "",
    });
  });

  it("goes back to the derived name when the display name is cleared", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "member");
    await clearDisplayName(env, EMAIL);

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(cardNameText(member)).toBe("Jane Doe");
  });
});

describe("a display name and the order sync", () => {
  it("survives a sync that rewrites the member's derived name", async () => {
    // The whole reason this lives in its own table. `deriveMembershipState()`
    // recomputes first_name/last_name from the latest counted order and the
    // upsert writes them unconditionally, so a name stored on `members` would
    // be reverted at the next sync -- silently, and when nobody is watching.
    await setDisplayName(env, EMAIL, "Chuy", "member");
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name,
         last_name, sku, status, created_on, expires_on, first_seen_via)
       VALUES ('9001_bc', 'bigcommerce', ?, ?, 'Janet', 'Doherty', 'LOSV-MEM-0001', 'Completed',
         '2098-01-15T00:00:00Z', '2099-01-15T00:00:00Z', 'sync')`,
    )
      .bind(EMAIL, EMAIL)
      .run();

    await refreshMemberFromOrders(env, EMAIL, {
      firstName: "Janet",
      lastName: "Doherty",
    });

    const member = (await getMemberByEmail(env, EMAIL))!;
    // The sync did its job on the derived name underneath...
    expect(member.first_name).toBe("Janet");
    // ...and the card still shows what the member asked for.
    expect(cardNameText(member)).toBe("Chuy");
  });

  it("moves last_updated_at, so installed passes are told to refresh", async () => {
    // The name lives outside `members`, so nothing else would move the
    // timestamp Apple's polling endpoint compares against -- the name would
    // change everywhere except on the passes already in people's phones.
    const before = await env.DB.prepare(
      "SELECT last_updated_at FROM members WHERE email = ?",
    )
      .bind(EMAIL)
      .first<{ last_updated_at: number }>();

    await setDisplayName(env, EMAIL, "Chuy", "member");

    const after = await env.DB.prepare(
      "SELECT last_updated_at FROM members WHERE email = ?",
    )
      .bind(EMAIL)
      .first<{ last_updated_at: number }>();
    expect(after!.last_updated_at).toBeGreaterThan(before!.last_updated_at);
  });
});

describe("what a member may type", () => {
  it.each([
    ["  Chuy  ", "Chuy"],
    ["Chuy   del   Norte", "Chuy del Norte"],
    ["Chuy\ndel Norte", "Chuy del Norte"],
  ])("collapses whitespace in %j", (raw, expected) => {
    // A pasted name can carry newlines, which would otherwise smuggle blank
    // lines onto a pass.
    expect(normalizeDisplayName(raw)).toEqual({ ok: true, value: expected });
  });

  it.each(["", "   ", "\n"])("refuses %j, which is a clear rather than a name", (raw) => {
    expect(normalizeDisplayName(raw).ok).toBe(false);
  });

  it("refuses something too long to fit on a card", () => {
    expect(normalizeDisplayName("x".repeat(65)).ok).toBe(false);
  });

  it("allows a name that is not the member's real one", () => {
    // Decided 2026-09-20: a card is a fun vanity item rather than an identity
    // document, so this is fine and needs no approval.
    expect(normalizeDisplayName("Goalkeeper Supreme")).toEqual({
      ok: true,
      value: "Goalkeeper Supreme",
    });
  });
});

describe("the member-facing page", () => {
  it("shows the name the card currently carries", async () => {
    const res = await request("/name");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Jane Doe");
  });

  it("saves a submitted name and redirects", async () => {
    const res = await request("/name", form({ display_name: "Chuy" }));

    expect(res.status).toBe(303);
    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(cardNameText(member)).toBe("Chuy");
  });

  it("records who set it, so a surprised member can be told", async () => {
    await request("/name", form({ display_name: "Chuy" }));

    const row = await env.DB.prepare(
      "SELECT source FROM member_display_names WHERE email = ?",
    )
      .bind(EMAIL)
      .first<{ source: string }>();
    expect(row?.source).toBe("member");
  });

  it("clears back to the derived name when asked", async () => {
    await setDisplayName(env, EMAIL, "Chuy", "member");

    const res = await request("/name", form({ clear: "1" }));

    expect(res.status).toBe(303);
    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(cardNameText(member)).toBe("Jane Doe");
  });

  it("says what is wrong rather than saving an empty name", async () => {
    const res = await request("/name", form({ display_name: "   " }));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter a name");
  });

  it("is behind a login", async () => {
    const res = await worker.fetch(
      new Request("https://card.losverd.es/name", { redirect: "manual" }),
      env,
      createExecutionContext(),
    );

    expect(res.status).toBe(302);
  });
});
