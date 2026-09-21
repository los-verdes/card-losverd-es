import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAddressList } from "../../src/admin/adminAccess";
import { linkOAuthUser } from "../../src/auth/oauth-link";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const OTHER_ADMIN_ID = 2;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare(
    "INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1), (?, 'other.admin@example.com', 1)",
  )
    .bind(ADMIN_ID, OTHER_ADMIN_ID)
    .run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM oauth_identities");
  await env.DB.exec("DELETE FROM users");
});

async function request(init: RequestInit = {}, asUser: number | null = ADMIN_ID) {
  const headers = new Headers(init.headers);
  if (asUser !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: asUser, isAdmin: true });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  if (init.method === "POST") headers.set("Origin", "https://card.losverd.es");
  const res = await worker.fetch(
    new Request("https://card.losverd.es/admin/admins", { ...init, headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
  return { status: res.status, location: res.headers.get("Location"), body: await res.text() };
}

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return request({ method: "POST", body });
}

async function isAdmin(email: string) {
  const row = await env.DB.prepare("SELECT is_admin FROM users WHERE email = ?").bind(email).first<{ is_admin: number }>();
  return row?.is_admin === 1;
}

async function auditLines() {
  const { results } = await env.DB.prepare(
    "SELECT action, subject_email, actor_email FROM audit_log ORDER BY id",
  ).all();
  return results;
}

describe("the admins page", () => {
  it("lists the admins, and marks which one is you", async () => {
    const { status, body } = await request();

    expect(status).toBe(200);
    expect(body).toContain("admin@example.com");
    expect(body).toContain("other.admin@example.com");
    expect(body).toContain("You");
  });

  it("is for admins only", async () => {
    await env.DB.prepare("INSERT INTO users (id, email) VALUES (3, 'member@example.com')").run();

    expect((await request({}, 3)).status).toBe(403);
    expect((await request({}, null)).status).toBe(302);
  });

  it("grants several people at once, including ones who have never signed in", async () => {
    // The case this is for: setting up a committee in one go, without waiting
    // for each person to sign in first.
    await env.DB.prepare("INSERT INTO users (id, email) VALUES (3, 'existing@example.com')").run();

    const { status, body } = await post({
      action: "grant",
      addresses: "Existing@Example.com,\nnew.one@example.com  new.two@example.com; admin@example.com, not-an-address",
    });

    expect(status).toBe(200);
    for (const email of ["existing@example.com", "new.one@example.com", "new.two@example.com"]) {
      expect(await isAdmin(email)).toBe(true);
    }
    expect(body).toContain("new.one@example.com: Now an admin; it applies when they first sign in");
    expect(body).toContain("existing@example.com: Now an admin.");
    expect(body).toContain("admin@example.com: Already an admin.");
    expect(body).toContain("not-an-address: Not an email address; nothing done.");
    expect(await auditLines()).toEqual(
      ["existing@example.com", "new.one@example.com", "new.two@example.com"].map((email) => ({
        action: "admin.granted",
        subject_email: email,
        actor_email: "admin@example.com",
      })),
    );
  });

  it("keeps a grant made before someone signs in, and takes their name at first sign-in", async () => {
    await post({ action: "grant", addresses: "new.one@example.com" });

    const user = await linkOAuthUser(env, {
      provider: "google",
      providerUserId: "google-new-one",
      email: "New.One@example.com",
      fullName: "Nova One",
    });

    expect(user.is_admin).toBe(1);
    expect(
      await env.DB.prepare("SELECT full_name FROM users WHERE email = 'new.one@example.com'").first(),
    ).toEqual({ full_name: "Nova One" });
  });

  it("removes another admin, without putting their address in the URL", async () => {
    const { status, location } = await post({ action: "revoke", email: "other.admin@example.com" });

    expect(status).toBe(303);
    expect(location).toBe("/admin/admins?saved=revoked");
    expect(await isAdmin("other.admin@example.com")).toBe(false);
    expect(await auditLines()).toEqual([
      { action: "admin.revoked", subject_email: "other.admin@example.com", actor_email: "admin@example.com" },
    ]);
  });

  it("will not let an admin remove themselves", async () => {
    // So the last admin cannot lock everybody out in one click. The command
    // line still can, deliberately.
    const { status, body } = await post({ action: "revoke", email: "Admin@Example.com" });

    expect(status).toBe(400);
    expect(body).toContain("remove your own admin access here");
    expect(await isAdmin("admin@example.com")).toBe(true);
    expect(await auditLines()).toEqual([]);
  });

  it("says so when asked to remove someone who is not an admin, or to grant nobody", async () => {
    expect((await post({ action: "revoke", email: "nobody@example.com" })).body).toContain("not an admin");
    expect((await post({ action: "grant", addresses: " , " })).body).toContain("Enter at least one address");
  });

  it("refuses a cross-site form post", async () => {
    const body = new FormData();
    body.append("action", "grant");
    body.append("addresses", "attacker@example.com");
    const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
    const res = await worker.fetch(
      new Request("https://card.losverd.es/admin/admins", {
        method: "POST",
        body,
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, Origin: "https://evil.example" },
      }),
      env,
      createExecutionContext(),
    );

    expect(res.status).toBe(403);
    expect(await isAdmin("attacker@example.com")).toBe(false);
  });
});

describe("parseAddressList", () => {
  it("splits on commas, semicolons and whitespace, lower-cases, and drops repeats", () => {
    expect(parseAddressList(" A@x.com,b@y.com;\n\ta@X.com  c@z.com ")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(parseAddressList("")).toEqual([]);
  });
});
