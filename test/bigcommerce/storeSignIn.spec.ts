import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { customerLoginUrl } from "../../src/bigcommerce/storeSignIn";
import { linkStoreAccount } from "../../src/bigcommerce/storeAccount";
import worker from "../../src/index";

const CLIENT_ID = "app-client-id";
const SECRET = "app-client-secret-0123456789abcdef";
const STORE = "https://store.example.com";
const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const CUSTOMER = 4242;

beforeEach(async () => {
  env.BIGCOMMERCE_APP_CLIENT_ID = CLIENT_ID;
  env.BIGCOMMERCE_APP_CLIENT_SECRET = SECRET;
  env.BIGCOMMERCE_STOREFRONT_URL = STORE;
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, 'jane@example.com')").bind(USER_ID).run();
});

afterEach(async () => {
  env.BIGCOMMERCE_APP_CLIENT_ID = "";
  env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM users");
});

async function go(query = "", signedIn = true) {
  const headers = new Headers();
  if (signedIn) headers.set("Cookie", `${SESSION_COOKIE_NAME}=${await issueSessionToken(SESSION_KEY, { userId: USER_ID, isAdmin: false })}`);
  return worker.fetch(new Request(`https://card.losverd.es/store/go${query}`, { headers, redirect: "manual" }), env, createExecutionContext());
}

/** The Customer Login JWT a redirect carries, verified as the store would verify it. */
async function loginClaims(location: string) {
  const match = /^https:\/\/store\.example\.com\/login\/token\/([^/?#]+)$/.exec(location);
  expect(match, location).not.toBeNull();
  const { payload, protectedHeader } = await jwtVerify(match![1], new TextEncoder().encode(SECRET), { issuer: CLIENT_ID });
  return { payload, protectedHeader };
}

describe("GET /store/go", () => {
  it("signs a member with a connected store account in to the store, through Customer Login", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    const before = Math.floor(Date.now() / 1000);

    const res = await go();

    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { payload, protectedHeader } = await loginClaims(res.headers.get("Location")!);
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload).toMatchObject({
      iss: CLIENT_ID,
      operation: "customer_login",
      store_hash: env.BIGCOMMERCE_STORE_HASH,
      customer_id: CUSTOMER,
      redirect_to: "/",
    });
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(typeof payload.jti).toBe("string");
  });

  it("lands on the membership page to renew, with a fresh token each time", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    const first = await loginClaims((await go("?to=renew")).headers.get("Location")!);
    const second = await loginClaims((await go("?to=renew")).headers.get("Location")!);

    expect(first.payload.redirect_to).toBe("/membership/");
    expect(first.payload.jti).not.toBe(second.payload.jti);
  });

  it("is a plain link for anyone it can't sign in: not connected, signed out, or expelled", async () => {
    expect((await go()).headers.get("Location")).toBe(`${STORE}/`);
    expect((await go("?to=renew", false)).headers.get("Location")).toBe(`${STORE}/membership/`);

    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES ('jane@example.com')").run();
    expect((await go()).headers.get("Location")).toBe(`${STORE}/`);
  });

  it("is a plain link where the environment has no store app, to its own store or the store", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    env.BIGCOMMERCE_APP_CLIENT_ID = "";

    expect((await go("?to=anything")).headers.get("Location")).toBe(`${STORE}/`);
    env.BIGCOMMERCE_STOREFRONT_URL = undefined;
    expect((await go("?to=renew")).headers.get("Location")).toBe("https://store.losverdesatx.org/membership/");
  });
});

describe("customerLoginUrl", () => {
  it("dates the token as asked, for the store's 30-second window", async () => {
    const url = await customerLoginUrl({ clientId: CLIENT_ID, clientSecret: SECRET, storeHash: "abc123" }, STORE, 1, "/", 1_790_000_000);
    const token = url.split("/login/token/")[1];
    const [, body] = token.split(".");
    expect(JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ iat: 1_790_000_000, store_hash: "abc123", customer_id: 1 });
  });
});
