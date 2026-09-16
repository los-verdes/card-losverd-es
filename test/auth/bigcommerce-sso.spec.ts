import { createExecutionContext, env } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../../src/auth/session";
import worker from "../../src/index";

const CLIENT_SECRET = "test-bigcommerce-client-secret-0123";
const CLIENT_ID = "test-client-id";
const STORE_HASH = "store123";
const SESSION_KEY = "test-session-signing-key-0123456789";

interface ClaimOverrides {
  customer?: unknown;
  store_hash?: unknown;
  operation?: unknown;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  secret?: string;
  alg?: string;
}

async function storefrontJwt(overrides: ClaimOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    customer: { id: 7, email: "Jane.Doe@Example.com", group_id: "0" },
    store_hash: STORE_HASH,
    operation: "current_customer",
    version: 1,
  };
  for (const key of ["customer", "store_hash", "operation"] as const) {
    if (key in overrides) claims[key] = overrides[key];
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: overrides.alg ?? "HS256" })
    .setIssuer(overrides.iss ?? "bc/apps")
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(STORE_HASH)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "15m")
    .sign(new TextEncoder().encode(overrides.secret ?? CLIENT_SECRET));
}

async function login(token: string, storeHash = STORE_HASH) {
  return worker.fetch(
    new Request(`https://card.losverd.es/storefront/${storeHash}/members/${token}/login`),
    env,
    createExecutionContext(),
  );
}

beforeEach(() => {
  env.BIGCOMMERCE_CLIENT_SECRET = CLIENT_SECRET;
  env.BIGCOMMERCE_CLIENT_ID = CLIENT_ID;
  env.BIGCOMMERCE_STORE_HASH = STORE_HASH;
  env.SESSION_SIGNING_KEY = SESSION_KEY;
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM users");
});

describe("GET /storefront/:storeHash/members/:jwt/login", () => {
  it("creates the user, issues a session cookie, and redirects home", async () => {
    const res = await login(await storefrontJwt());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    const user = await env.DB.prepare("SELECT id, email, bigcommerce_id FROM users").first<{
      id: number;
      email: string;
      bigcommerce_id: number;
    }>();
    expect(user?.email).toBe("jane.doe@example.com");
    expect(user?.bigcommerce_id).toBe(7);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    const token = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
    const session = await verifySessionToken(SESSION_KEY, token!);
    expect(session?.userId).toBe(user?.id);
    expect(session?.isAdmin).toBe(false);
  });

  it("reuses an existing user matched by email, preserving admin status", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (99, 'jane.doe@example.com', 1)").run();

    const res = await login(await storefrontJwt());

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(1);
    const token = res.headers.get("Set-Cookie")?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
    const session = await verifySessionToken(SESSION_KEY, token!);
    expect(session).toMatchObject({ userId: 99, isAdmin: true });
  });

  it.each<[string, () => Promise<string>, string?]>([
    ["wrong signing secret", () => storefrontJwt({ secret: "some-other-client-secret-abcdef" })],
    ["expired token", () => storefrontJwt({ expiresIn: "-1m" })],
    ["wrong issuer", () => storefrontJwt({ iss: "cats" })],
    ["wrong audience (another app)", () => storefrontJwt({ aud: "another-app" })],
    ["non-HS256 HMAC alg", () => storefrontJwt({ alg: "HS512" })],
    ["token for a different store", () => storefrontJwt({ store_hash: "otherstore" })],
    ["URL store hash doesn't match the token", () => storefrontJwt(), "otherstore"],
    [
      "another store running the same app (token + URL agree, but not this deployment's store)",
      () => storefrontJwt({ store_hash: "otherstore" }),
      "otherstore",
    ],
    ["wrong operation", () => storefrontJwt({ operation: "something_else" })],
    ["missing customer", () => storefrontJwt({ customer: undefined })],
    ["non-numeric customer id", () => storefrontJwt({ customer: { id: "7", email: "a@b.c" } })],
    ["empty email", () => storefrontJwt({ customer: { id: 7, email: "" } })],
    ["garbage token", async () => "not-a-jwt"],
  ])("rejects: %s", async (_label, makeToken, storeHash) => {
    const res = await login(await makeToken(), storeHash);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("fails closed when the client secret isn't configured", async () => {
    const token = await storefrontJwt();
    env.BIGCOMMERCE_CLIENT_SECRET = "";
    const res = await login(token);
    expect(res.status).toBe(500);
  });
});
