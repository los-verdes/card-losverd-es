import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { SignJWT, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_LINK_TTL_MS, signedArtifactUrl, type StoreMemberResponse } from "../../src/bigcommerce/storeMember";
import worker from "../../src/index";
import { getTestCertChain } from "../fixtures/certChain";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";
import { fakeGoogleWallet } from "../google/fake";

const CLIENT_ID = "app-client-id";
const SECRET = "app-client-secret-0123456789abcdef";
const STORE = "https://store.example.com";
const CUSTOMER = 4242;
const EMAIL = "jane@example.com";

async function currentJwt(customerId = CUSTOMER, secret = SECRET) {
  return new SignJWT({ customer: { id: customerId, email: "shopper@example.com" }, store_hash: env.BIGCOMMERCE_STORE_HASH, operation: "current_customer" })
    .setProtectedHeader({ alg: "HS512", typ: "JWT" })
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret));
}

function fetchWorker(path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : `https://card.losverd.es${path}`;
  return worker.fetch(new Request(url, { ...init, redirect: "manual" }), env, createExecutionContext());
}

const ask = async (token?: string, origin: string | null = STORE) =>
  fetchWorker("/store/member", {
    headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

async function seed({ connected = true, expiration = "2099-02-14" } = {}) {
  await env.DB.prepare("INSERT INTO users (id, email, bigcommerce_id) VALUES (7, ?, ?)").bind(EMAIL, connected ? CUSTOMER : null).run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES ('BC-1', 'Jane', 'Doe', ?, ?, '2021-07-15', 'token', 1)`,
  )
    .bind(EMAIL, expiration)
    .run();
}

beforeEach(() => {
  env.BIGCOMMERCE_APP_CLIENT_ID = CLIENT_ID;
  env.BIGCOMMERCE_APP_CLIENT_SECRET = SECRET;
  env.BIGCOMMERCE_STOREFRONT_URL = STORE;
  env.SESSION_SIGNING_KEY = "test-session-signing-key-0123456789";
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key-0123456789";
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.BIGCOMMERCE_APP_CLIENT_ID = "";
  env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("GET /store/member", () => {
  it("answers the store's own origin only, with its CORS headers, preflight included", async () => {
    const preflight = await fetchWorker("/store/member", { method: "OPTIONS", headers: { Origin: STORE, "Access-Control-Request-Headers": "authorization" } });
    expect(preflight.status).toBe(204);
    for (const [name, value] of [
      ["Access-Control-Allow-Origin", STORE],
      ["Access-Control-Allow-Headers", "Authorization"],
      ["Access-Control-Allow-Methods", "GET"],
      ["Vary", "Origin"],
    ]) {
      expect(preflight.headers.get(name)).toBe(value);
    }
    expect((await fetchWorker("/store/member", { method: "OPTIONS", headers: { Origin: "https://evil.example.com" } })).status).toBe(403);

    expect((await ask(await currentJwt(), "https://evil.example.com")).status).toBe(403);
    const res = await ask(await currentJwt());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(STORE);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses a token that isn't the store's, still answering the store's origin", async () => {
    const outcomes = spyOnOutcomes();
    for (const token of [undefined, "nonsense", await currentJwt(CUSTOMER, "another-secret-0123456789abcdef")]) {
      const res = await ask(token);
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(STORE);
    }
    expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "store.member", result: "refused", reason: "signature" });
  });

  it("says a store account isn't connected", async () => {
    await seed({ connected: false });
    expect(await (await ask(await currentJwt())).json()).toEqual({ connected: false });
  });

  it("gives a connected member their card, with signed links to it, and takes the same token again", async () => {
    await seed();
    const token = await currentJwt();

    const first = (await (await ask(token)).json()) as StoreMemberResponse;
    const again = await ask(token);

    expect(again.status).toBe(200);
    expect(first).toMatchObject({
      connected: true,
      member: { name: "Jane Doe", cardNumber: "BC-1", goodThrough: "2099-02-14", memberSince: "2021-07-15", current: true },
    });
    const member = first.connected && first.member ? first.member : null;
    expect(member?.cardImageUrl).toMatch(/^https:\/\/card\.losverd\.es\/store\/card\.png\?m=BC-1&x=\d+&s=[\w-]+$/);
    expect(member?.appleWalletUrl).toMatch(/^https:\/\/card\.losverd\.es\/store\/apple\.pkpass\?/);
    expect(member).not.toHaveProperty("googleWalletUrl"); // not configured here
  });

  it("says when the membership ran out, with no links, and shows nothing to somebody expelled", async () => {
    await seed({ expiration: "2020-02-14" });
    expect(await (await ask(await currentJwt())).json()).toEqual({
      connected: true,
      member: { name: "Jane Doe", cardNumber: "BC-1", goodThrough: "2020-02-14", memberSince: "2021-07-15", current: false },
    });

    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES (?)").bind(EMAIL).run();
    expect(await (await ask(await currentJwt())).json()).toEqual({ connected: true, member: null });
  });

  it("says when a connected account holds no membership at all", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, bigcommerce_id) VALUES (7, ?, ?)").bind(EMAIL, CUSTOMER).run();
    expect(await (await ask(await currentJwt())).json()).toEqual({ connected: true, member: null });
  });

  it("is not there until the environment has an app", async () => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "";
    expect((await ask(await currentJwt())).status).toBe(404);
    expect((await fetchWorker("/store/member", { method: "OPTIONS", headers: { Origin: STORE } })).status).toBe(403);
  });
});

describe("the signed links", () => {
  it("serve the card image to whoever holds one, while it lasts and the membership is current", async () => {
    await seed();
    const url = await signedArtifactUrl(env, "card", "BC-1");

    const res = await fetchWorker(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");

    const tampered = url.replace("m=BC-1", "m=BC-2");
    const otherArtifact = url.replace("/store/card.png", "/store/apple.pkpass");
    const stale = await signedArtifactUrl(env, "card", "BC-1", Date.now() - STORE_LINK_TTL_MS - 1);
    for (const bad of [tampered, otherArtifact, stale, "https://card.losverd.es/store/card.png"]) {
      const refused = await fetchWorker(bad);
      expect(refused.status).toBe(404);
      expect(await refused.text()).toContain("This link from the store has run out");
    }

    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('BC-1')").run();
    expect((await fetchWorker(url)).status).toBe(404);
  });

  it("serve the Apple pass", async () => {
    await seed();
    const chain = getTestCertChain();
    Object.assign(env, {
      PASSKIT_PASS_TYPE_IDENTIFIER: "pass.es.losverd.card.test",
      PASSKIT_TEAM_IDENTIFIER: "TEAMID1234",
      PASSKIT_ORGANIZATION_NAME: "Los Verdes",
      PASSKIT_WEB_SERVICE_URL: "https://card.losverd.es/passkit",
      APPLE_PASS_CERT_PEM: chain.leafCertPem,
      APPLE_PASS_KEY_PEM: chain.leafPrivateKeyPem,
      APPLE_WWDR_CERT_PEM: chain.rootCertPem,
    });
    const outcomes = spyOnOutcomes();

    const res = await fetchWorker(await signedArtifactUrl(env, "apple", "BC-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.apple.pkpass");
    expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "pass.downloaded", wallet: "apple", from: "store" });
    await env.ASSETS.delete("cache/pkpass/pass.es.losverd.card.test/BC-1.pkpass");
  });

  it("send a Google Wallet link to Google, once it is configured, and say so when it isn't there", async () => {
    await seed();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => fakeGoogleWallet(input instanceof Request ? input.url : String(input)));

    const body = (await (await ask(await currentJwt())).json()) as StoreMemberResponse;
    const googleUrl = body.connected && body.member ? body.member.googleWalletUrl : undefined;
    expect(googleUrl).toMatch(/^https:\/\/card\.losverd\.es\/store\/google\?/);

    const res = await fetchWorker(googleUrl!);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);

    vi.spyOn(console, "error").mockImplementation(() => {});
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = "not a key";
    const failed = await fetchWorker(await signedArtifactUrl(env, "google", "BC-1"));
    expect(failed.status).toBe(503);
  });
});
