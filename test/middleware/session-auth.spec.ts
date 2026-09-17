import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  issueSessionToken,
  verifySessionToken,
} from "../../src/auth/session";
import {
  LOGIN_PATH,
  NO_ACTIVE_MEMBERSHIP_PATH,
  requireActiveMembership,
  requireAdmin,
  requireAuth,
  type AuthEnv,
} from "../../src/middleware/auth";

const SECRET = "test-session-signing-key-0123456789";

function buildApp() {
  const app = new Hono<AuthEnv>();
  app.get("/me", requireAuth, (c) => c.json(c.get("session")));
  app.get("/admin", requireAdmin, (c) => c.text("admin ok"));
  app.get("/card", requireActiveMembership, (c) => c.text("card ok"));
  return app;
}

async function request(path: string, token?: string) {
  const headers = token ? { Cookie: `${SESSION_COOKIE_NAME}=${token}` } : undefined;
  return buildApp().request(path, { headers }, env);
}

async function insertUser(id: number, email: string, isAdmin = false) {
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, ?)")
    .bind(id, email, isAdmin ? 1 : 0)
    .run();
}

async function insertMember(fields: {
  memberId: string;
  email: string;
  userId?: number | null;
  status?: string;
  expirationDate: string;
}) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status, expiration_date, user_id, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, ?, ?, ?, 'token', 0)`,
  )
    .bind(
      fields.memberId,
      fields.email,
      fields.status ?? "active",
      fields.expirationDate,
      fields.userId ?? null,
    )
    .run();
}

function setCookieToken(res: Response): string | null {
  const header = res.headers.get("Set-Cookie");
  const match = header?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}

beforeEach(() => {
  env.SESSION_SIGNING_KEY = SECRET;
});

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("requireAuth", () => {
  it("redirects to login with no session cookie", async () => {
    const res = await request("/me");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(LOGIN_PATH);
  });

  it("redirects to login with an invalid session cookie", async () => {
    const res = await request("/me", "garbage");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(LOGIN_PATH);
  });

  it("passes a fresh session through without renewing or reading D1", async () => {
    const token = await issueSessionToken(SECRET, { userId: 5, isAdmin: false });
    const res = await request("/me", token);
    expect(res.status).toBe(200);
    expect((await res.json<{ userId: number }>()).userId).toBe(5);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("renews a session past its halfway point, re-reading the user's admin flag from D1", async () => {
    await insertUser(5, "jane@example.com", false);
    const issuedAt = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS / 2 - 60;
    const staleAdminToken = await issueSessionToken(SECRET, { userId: 5, isAdmin: true }, issuedAt);

    const res = await request("/me", staleAdminToken);

    expect(res.status).toBe(200);
    expect((await res.json<{ isAdmin: boolean }>()).isAdmin).toBe(false);
    const renewed = setCookieToken(res);
    expect(renewed).toBeTruthy();
    const renewedSession = await verifySessionToken(SECRET, renewed!);
    expect(renewedSession?.issuedAt).toBeGreaterThan(issuedAt);
    expect(renewedSession?.isAdmin).toBe(false);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("logs out (clears the cookie) when a renewing session's user no longer exists", async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS / 2 - 60;
    const token = await issueSessionToken(SECRET, { userId: 404, isAdmin: false }, issuedAt);

    const res = await request("/me", token);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(LOGIN_PATH);
    expect(res.headers.get("Set-Cookie")).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;`));
  });
});

describe("requireAdmin", () => {
  it("redirects unauthenticated requests to login", async () => {
    const res = await request("/admin");
    expect(res.status).toBe(302);
  });

  it("allows a user who is an admin in D1", async () => {
    await insertUser(1, "admin@example.com", true);
    const token = await issueSessionToken(SECRET, { userId: 1, isAdmin: true });
    const res = await request("/admin", token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("admin ok");
  });

  it("rejects a demoted admin even though their cookie still says isAdmin", async () => {
    await insertUser(1, "former-admin@example.com", false);
    const token = await issueSessionToken(SECRET, { userId: 1, isAdmin: true });
    const res = await request("/admin", token);
    expect(res.status).toBe(403);
  });

  it("still sets a renewed cookie when renewal happens on an admin route", async () => {
    await insertUser(1, "admin@example.com", true);
    const issuedAt = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS / 2 - 60;
    const token = await issueSessionToken(SECRET, { userId: 1, isAdmin: true }, issuedAt);
    const res = await request("/admin", token);
    expect(res.status).toBe(200);
    expect(setCookieToken(res)).toBeTruthy();
  });
});

describe("requireActiveMembership", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-09-16T12:00:00.000Z"), toFake: ["Date"] });
  });

  async function cardRequestFor(userId: number) {
    const token = await issueSessionToken(SECRET, { userId, isAdmin: false });
    return request("/card", token);
  }

  it("redirects unauthenticated requests to login", async () => {
    const res = await request("/card");
    expect(res.headers.get("Location")).toBe(LOGIN_PATH);
  });

  it("allows a user whose membership is linked by user_id", async () => {
    await insertUser(1, "login@example.com");
    await insertMember({ memberId: "BC-1", email: "different@example.com", userId: 1, expirationDate: "2027-01-01" });
    expect((await cardRequestFor(1)).status).toBe(200);
  });

  it("allows a user whose (not yet linked) membership matches by email", async () => {
    await insertUser(1, "jane@example.com");
    await insertMember({ memberId: "BC-1", email: "jane@example.com", expirationDate: "2026-09-16" });
    expect((await cardRequestFor(1)).status).toBe(200);
  });

  it("redirects when the only membership has lapsed, even if status still says active", async () => {
    await insertUser(1, "jane@example.com");
    await insertMember({ memberId: "BC-1", email: "jane@example.com", status: "active", expirationDate: "2026-09-15" });
    const res = await cardRequestFor(1);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(NO_ACTIVE_MEMBERSHIP_PATH);
  });

  it("redirects when the membership is revoked", async () => {
    await insertUser(1, "jane@example.com");
    await insertMember({ memberId: "BC-1", email: "jane@example.com", status: "revoked", expirationDate: "2099-01-01" });
    expect((await cardRequestFor(1)).headers.get("Location")).toBe(NO_ACTIVE_MEMBERSHIP_PATH);
  });

  it("redirects a user with no membership at all", async () => {
    await insertUser(1, "jane@example.com");
    expect((await cardRequestFor(1)).headers.get("Location")).toBe(NO_ACTIVE_MEMBERSHIP_PATH);
  });
});
