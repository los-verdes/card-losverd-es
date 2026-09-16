import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { linkOAuthUser } from "../../src/auth/oauth-link";

const login = {
  provider: "google",
  providerUserId: "google-user-1",
  email: "Jane@Example.com",
  fullName: "Jane Doe",
};

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM oauth_identities");
  await env.DB.exec("DELETE FROM users");
});

describe("linkOAuthUser", () => {
  it("creates a user (lower-cased email, full name) and links the identity", async () => {
    const user = await linkOAuthUser(env, login);

    expect(user.is_admin).toBe(0);
    expect(await env.DB.prepare("SELECT email, full_name FROM users WHERE id = ?").bind(user.id).first()).toEqual({
      email: "jane@example.com",
      full_name: "Jane Doe",
    });
    expect(await env.DB.prepare("SELECT provider, provider_user_id, email_at_link_time FROM oauth_identities").first()).toEqual({
      provider: "google",
      provider_user_id: "google-user-1",
      email_at_link_time: "jane@example.com",
    });
  });

  it("returns the same user for a returning identity without duplicating rows", async () => {
    const first = await linkOAuthUser(env, login);
    const second = await linkOAuthUser(env, login);

    expect(second).toEqual(first);
    expect(await count("users")).toBe(1);
    expect(await count("oauth_identities")).toBe(1);
  });

  it("links a second provider to the same user by email", async () => {
    const google = await linkOAuthUser(env, login);
    const apple = await linkOAuthUser(env, {
      provider: "apple",
      providerUserId: "apple-user-1",
      email: "jane@example.com",
      fullName: null,
    });

    expect(apple.id).toBe(google.id);
    expect(await count("users")).toBe(1);
    expect(await count("oauth_identities")).toBe(2);
  });

  it("doesn't overwrite an existing user's name", async () => {
    await env.DB.prepare("INSERT INTO users (email, full_name) VALUES ('jane@example.com', 'Original Name')").run();

    await linkOAuthUser(env, login);

    expect(await env.DB.prepare("SELECT full_name FROM users").first()).toEqual({ full_name: "Original Name" });
  });

  it("follows the identity, not the email, once linked", async () => {
    const linked = await linkOAuthUser(env, login);
    await env.DB.prepare("INSERT INTO users (email) VALUES ('someone-else@example.com')").run();

    // Same provider identity, now reporting a different email address.
    const again = await linkOAuthUser(env, { ...login, email: "someone-else@example.com" });

    expect(again.id).toBe(linked.id);
  });
});
