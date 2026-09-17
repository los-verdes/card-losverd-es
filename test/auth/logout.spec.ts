import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";

const ORIGIN = "https://card.losverd.es";
const SESSION_KEY = "test-session-signing-key-0123456789";

async function logout(method: string, origin?: string) {
  const token = await issueSessionToken(SESSION_KEY, { userId: 1, isAdmin: false });
  const headers = new Headers({
    Cookie: `${SESSION_COOKIE_NAME}=${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (origin) headers.set("Origin", origin);
  return worker.fetch(
    new Request(`${ORIGIN}/logout`, { method, headers, body: method === "POST" ? "" : undefined, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

describe("POST /logout", () => {
  it("clears lv_session and redirects home", async () => {
    const res = await logout("POST", ORIGIN);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(new RegExp(`^${SESSION_COOKIE_NAME}=;.*Max-Age=0`)),
    );
  });

  it("refuses a cross-site form post (can't be used to log members out from another site)", async () => {
    const res = await logout("POST", "https://evil.example");

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("isn't reachable with GET", async () => {
    const res = await logout("GET", ORIGIN);
    expect(res.status).toBe(404);
  });
});
