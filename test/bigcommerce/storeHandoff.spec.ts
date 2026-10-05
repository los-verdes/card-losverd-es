import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken, verifySessionToken } from "../../src/auth/session";
import { AppJwtRejected, appConfig, verifyCurrentCustomer, verifySignedPayload } from "../../src/bigcommerce/appJwt";
import { BIGCOMMERCE_TOKEN_URL } from "../../src/bigcommerce/app";
import {
  StoreAccountTaken,
  claimHandoffToken,
  handoffTokenHeldBy,
  linkStoreAccount,
  rememberStoreEmail,
  storeAccountFor,
  unlinkStoreAccount,
  userForStoreCustomer,
} from "../../src/bigcommerce/storeAccount";
import { finishPendingStoreLink } from "../../src/bigcommerce/storeHandoff";
import worker from "../../src/index";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";

const CLIENT_ID = "app-client-id";
const SECRET = "app-client-secret-0123456789abcdef";
const STORE = "https://store.example.com";
const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const OTHER_ID = 8;
const CUSTOMER = 4242;

/** A storefront `current.jwt` as the store would sign it, with anything overridden. */
async function currentJwt(overrides: Record<string, unknown> = {}, secret = SECRET, expiresIn = "15m", alg = "HS512") {
  return new SignJWT({
    customer: { id: CUSTOMER, email: "shopper@example.com", group_id: "0" },
    store_hash: env.BIGCOMMERCE_STORE_HASH,
    operation: "current_customer",
    application_id: CLIENT_ID,
    ...overrides,
  })
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuer("bc/apps")
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

async function signedPayload(sub = `stores/${env.BIGCOMMERCE_STORE_HASH}`) {
  return new SignJWT({ user: { id: 99, email: "owner@example.com" }, owner: { id: 99 }, url: "/", channel_id: null })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("bc")
    .setSubject(sub)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

const app = () => appConfig(env)!;

async function audit() {
  const { results } = await env.DB.prepare("SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY id").all();
  return results;
}

function fetchWorker(path: string, init: RequestInit & { cookies?: string[] } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookies?.length) headers.set("Cookie", init.cookies.join("; "));
  return worker.fetch(new Request(`https://card.losverd.es${path}`, { ...init, headers, redirect: "manual" }), env, createExecutionContext());
}

/** The value a response set for a cookie, as `name=value`. */
function setCookie(res: Response, name: string): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header ? header.split(";")[0] : null;
}

async function sessionCookie(userId: number) {
  return `${SESSION_COOKIE_NAME}=${await issueSessionToken(SESSION_KEY, { userId, isAdmin: false })}`;
}

function handoffForm(jwt: string) {
  const body = new FormData();
  body.set("jwt", jwt);
  return { method: "POST", body, headers: { Origin: STORE } };
}

beforeEach(async () => {
  env.BIGCOMMERCE_APP_CLIENT_ID = CLIENT_ID;
  env.BIGCOMMERCE_APP_CLIENT_SECRET = SECRET;
  env.BIGCOMMERCE_STOREFRONT_URL = STORE;
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, 'jane@example.com'), (?, 'pat@example.com')").bind(USER_ID, OTHER_ID).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.BIGCOMMERCE_APP_CLIENT_ID = "";
  env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM store_handoff_tokens");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM users");
});

describe("the storefront's current.jwt", () => {
  it("names the signed-in customer", async () => {
    expect(await verifyCurrentCustomer(await currentJwt(), app())).toMatchObject({ customerId: CUSTOMER, email: "shopper@example.com" });
  });

  it("is accepted signed with HS256 as well as the store's HS512", async () => {
    expect(await verifyCurrentCustomer(await currentJwt({}, SECRET, "15m", "HS256"), app())).toMatchObject({ customerId: CUSTOMER });
  });

  it.each([
    ["another app's secret", () => currentJwt({}, "some-other-secret-0123456789"), "signature"],
    ["another store", () => currentJwt({ store_hash: "otherstore" }), "store"],
    ["another operation", () => currentJwt({ operation: "customer_login" }), "operation"],
    ["a guest", () => currentJwt({ customer: { id: 0 } }), "customer"],
    ["an expired token", () => currentJwt({}, SECRET, "-1m"), "expired"],
    ["an unexpected algorithm", () => currentJwt({}, SECRET, "15m", "HS384"), "alg"],
    ["something that is not a token", async () => "not-a-token", "malformed"],
  ])("is refused from %s", async (_, make, reason) => {
    await expect(verifyCurrentCustomer(await make(), app())).rejects.toMatchObject({ reason });
  });

  it("is refused when addressed to another app", async () => {
    const token = await new SignJWT({ customer: { id: CUSTOMER }, store_hash: env.BIGCOMMERCE_STORE_HASH, operation: "current_customer" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("another-app")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(SECRET));

    await expect(verifyCurrentCustomer(token, app())).rejects.toMatchObject({ reason: "claim:aud" });
  });

  it("is off until an app is configured", () => {
    env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
    expect(appConfig(env)).toBeNull();
  });
});

describe("the control panel's signed_payload_jwt", () => {
  it("is accepted for this store and refused for another", async () => {
    expect(await verifySignedPayload(await signedPayload(), app())).toEqual({ userId: 99 });
    await expect(verifySignedPayload(await signedPayload("stores/otherstore"), app())).rejects.toBeInstanceOf(AppJwtRejected);
  });
});

describe("connecting a store account", () => {
  it("links it to the user, and says so in the audit log", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    expect(await storeAccountFor(env, USER_ID)).toMatchObject({ customerId: CUSTOMER });
    expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(USER_ID);
    expect(await audit()).toEqual([
      { action: "store_account.linked", subject_email: "jane@example.com", actor_email: "jane@example.com", detail: `Store customer ${CUSTOMER}` },
    ]);
  });

  it("refuses an account connected to somebody else, rather than moving it", async () => {
    await linkStoreAccount(env, OTHER_ID, CUSTOMER, OTHER_ID);

    await expect(linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID)).rejects.toBeInstanceOf(StoreAccountTaken);
    expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(OTHER_ID);
  });

  it("replaces a member's earlier account, and records nothing for connecting the same one again", async () => {
    await linkStoreAccount(env, USER_ID, 1001, USER_ID);
    await linkStoreAccount(env, USER_ID, 1002, USER_ID);
    await linkStoreAccount(env, USER_ID, 1002, USER_ID);

    expect(await storeAccountFor(env, USER_ID)).toMatchObject({ customerId: 1002 });
    expect((await audit()).map((row) => row.detail)).toEqual(["Store customer 1001", "Store customer 1002 (was 1001)"]);
  });

  it("keeps the store's email for showing back: refreshed, kept when the store states none, dropped on disconnect", async () => {
    const email = async () => (await storeAccountFor(env, USER_ID))?.email;

    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID, "first@example.com");
    expect(await email()).toBe("first@example.com");

    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID, "second@example.com");
    expect(await email()).toBe("second@example.com");
    expect(await audit()).toHaveLength(1);

    await rememberStoreEmail(env, CUSTOMER, null);
    expect(await email()).toBe("second@example.com");

    await unlinkStoreAccount(env, USER_ID, USER_ID);
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    expect(await email()).toBeNull();
  });

  it("disconnects, recording who did it, and reports when there was nothing to disconnect", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    expect(await unlinkStoreAccount(env, USER_ID, OTHER_ID)).toBe(true);
    expect(await unlinkStoreAccount(env, USER_ID, OTHER_ID)).toBe(false);
    expect(await storeAccountFor(env, USER_ID)).toBeNull();
    expect((await audit())[1]).toMatchObject({ action: "store_account.unlinked", actor_email: "pat@example.com" });
  });
});

describe("spending a handoff token", () => {
  it("accepts each token once, and forgets it once it would have expired", async () => {
    const later = Math.floor(Date.now() / 1000) + 600;
    expect(await claimHandoffToken(env, "token-a", later, "marker-1")).toMatchObject({ claimed: true });
    expect(await claimHandoffToken(env, "token-a", later, "marker-2")).toMatchObject({ claimed: false });

    await claimHandoffToken(env, "token-b", Math.floor(Date.now() / 1000) - 1, "marker-3");
    await claimHandoffToken(env, "token-c", later, "marker-4");
    const { results } = await env.DB.prepare("SELECT token_hash, browser_hash FROM store_handoff_tokens").all<{ token_hash: string; browser_hash: string }>();
    expect(results).toHaveLength(2);
    expect(results.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash) && /^[0-9a-f]{64}$/.test(row.browser_hash))).toBe(true);
  });

  it("knows which browser spent a token, while it is in date", async () => {
    const later = Math.floor(Date.now() / 1000) + 600;
    const { tokenHash } = await claimHandoffToken(env, "token-a", later, "first-browser");
    await claimHandoffToken(env, "token-a", later, "second-browser");

    expect(await handoffTokenHeldBy(env, tokenHash, "first-browser")).toBe(true);
    expect(await handoffTokenHeldBy(env, tokenHash, "second-browser")).toBe(false);
    expect(await handoffTokenHeldBy(env, "0".repeat(64), "first-browser")).toBe(false);

    const { tokenHash: expired } = await claimHandoffToken(env, "token-b", Math.floor(Date.now() / 1000) - 1, "first-browser");
    expect(await handoffTokenHeldBy(env, expired, "first-browser")).toBe(false);
  });
});

describe("POST /store-handoff", () => {
  it("verifies and spends the token, then continues on the card site with it kept in a signed cookie", async () => {
    const res = await fetchWorker("/store-handoff", handoffForm(await currentJwt()));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/store-handoff/continue");
    expect(setCookie(res, "lv_store_link")).toMatch(new RegExp(`^lv_store_link=${CUSTOMER}\\.\\d+\\.[A-Za-z0-9_-]*\\.\\.[A-Za-z0-9_-]+$`));
    const attributes = res.headers.getSetCookie().find((c) => c.startsWith("lv_store_link="))!;
    for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Max-Age=600/i, /Path=\//i]) {
      expect(attributes).toMatch(attribute);
    }
  });

  it("marks the browser that spent the token, for as long as the token lasts, on the handoff's paths only", async () => {
    const res = await fetchWorker("/store-handoff", handoffForm(await currentJwt()));

    expect(setCookie(res, "lv_store_browser")).toMatch(/^lv_store_browser=[0-9a-f]{64}$/);
    const attributes = res.headers.getSetCookie().find((c) => c.startsWith("lv_store_browser="))!;
    for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\/store-handoff(;|$)/i]) {
      expect(attributes).toMatch(attribute);
    }
    expect(Number(/Max-Age=(\d+)/i.exec(attributes)![1])).toBeGreaterThan(800);
    expect(Number(/Max-Age=(\d+)/i.exec(attributes)![1])).toBeLessThanOrEqual(900);
  });

  it("refuses a request from anywhere but the store", async () => {
    const form = handoffForm(await currentJwt());
    const res = await fetchWorker("/store-handoff", { ...form, headers: { Origin: "https://evil.example.com" } });

    expect(res.status).toBe(403);
    expect(setCookie(res, "lv_store_link")).toBeNull();
  });

  it("says to go back to the store for a token that is bad", async () => {
    const outcomes = spyOnOutcomes();
    const forged = await fetchWorker("/store-handoff", handoffForm(await currentJwt({}, "wrong-secret-0123456789")));

    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("Back to the store");
    expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "store.handoff", result: "refused", reason: "signature" });
  });

  it("sends a spent token on with the customer marked as unproven, and gives that browser no marker", async () => {
    const token = await currentJwt();
    await fetchWorker("/store-handoff", handoffForm(token));

    const replayed = await fetchWorker("/store-handoff", handoffForm(token));

    expect(replayed.status).toBe(303);
    expect(replayed.headers.get("Location")).toBe("/store-handoff/continue");
    expect(setCookie(replayed, "lv_store_link")).toMatch(new RegExp(`^lv_store_link=${CUSTOMER}\\.\\d+\\.[A-Za-z0-9_-]*\\.[0-9a-f]{64}\\.`));
    expect(setCookie(replayed, "lv_store_browser")).toBeNull();
    expect(setCookie(replayed, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("is not there until the environment has an app", async () => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "";
    expect((await fetchWorker("/store-handoff", handoffForm(await currentJwt()))).status).toBe(404);
  });
});

describe("GET /store-handoff/continue", () => {
  async function pending() {
    return setCookie(await fetchWorker("/store-handoff", handoffForm(await currentJwt())), "lv_store_link")!;
  }

  it("signs in whoever the store account is connected to", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    const res = await fetchWorker("/store-handoff/continue", { cookies: [await pending()] });

    expect(res.headers.get("Location")).toBe("/");
    const session = await verifySessionToken(SESSION_KEY, setCookie(res, SESSION_COOKIE_NAME)!.split("=")[1]);
    expect(session?.userId).toBe(USER_ID);
    expect(setCookie(res, "lv_store_link")).toBe("lv_store_link=");
  });

  it("marks the browser as having come from the store, until it closes", async () => {
    for (const cookies of [[await pending()], []]) {
      const res = await fetchWorker("/store-handoff/continue", { cookies });
      const header = res.headers.getSetCookie().find((c) => c.startsWith("lv_from_store="))!;

      expect(header.split(";")[0]).toBe("lv_from_store=1");
      expect(header).not.toMatch(/Max-Age|Expires/i);
      expect(header).toMatch(/HttpOnly/);
    }
  });

  it("keeps the connected account's email as the store states it now", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID, "old@example.com");

    await fetchWorker("/store-handoff/continue", { cookies: [await pending()] });

    expect((await storeAccountFor(env, USER_ID))?.email).toBe("shopper@example.com");
  });

  it("keeps the store's email when it connects the account of somebody signed in here", async () => {
    await fetchWorker("/store-handoff/continue", { cookies: [await pending(), await sessionCookie(USER_ID)] });

    expect(await storeAccountFor(env, USER_ID)).toMatchObject({ customerId: CUSTOMER, email: "shopper@example.com" });
  });

  it("refuses to sign in somebody expelled", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES ('jane@example.com')").run();

    const res = await fetchWorker("/store-handoff/continue", { cookies: [await pending()] });

    expect(res.headers.get("Location")).toBe("/login?error=account-blocked");
    expect(setCookie(res, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("connects an unconnected account to the member already signed in here", async () => {
    const res = await fetchWorker("/store-handoff/continue", { cookies: [await pending(), await sessionCookie(USER_ID)] });

    expect(res.headers.get("Location")).toBe("/?store=connected");
    expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(USER_ID);
  });

  it("asks somebody not signed in to sign in once, keeping the account waiting", async () => {
    const res = await fetchWorker("/store-handoff/continue", { cookies: [await pending()] });

    expect(res.headers.get("Location")).toBe("/login?connect=store");
    expect(setCookie(res, "lv_store_link")).toBeNull();
    expect(await userForStoreCustomer(env, CUSTOMER)).toBeNull();
    expect(await (await fetchWorker("/login?connect=store")).text()).toContain("Sign in once to connect your store account");
  });

  it("names the store account's email on the sign-in page, as a hint only", async () => {
    const cookie = await pending();

    const page = await (await fetchWorker("/login?connect=store", { cookies: [cookie] })).text();
    expect(page).toContain("Your store account uses <strong>shopper@example.com</strong>");

    // Without one waiting, or without the store saying, there is no hint.
    expect(await (await fetchWorker("/login?connect=store")).text()).not.toContain("Your store account uses");
    const noEmail = setCookie(
      await fetchWorker("/store-handoff", handoffForm(await currentJwt({ customer: { id: CUSTOMER } }))),
      "lv_store_link",
    )!;
    expect(await (await fetchWorker("/login?connect=store", { cookies: [noEmail] })).text()).not.toContain("Your store account uses");
  });

  describe("with a token already spent, as the store hands out the same one for 15 minutes", () => {
    /** Spends a token in one browser, then presents it again; returns that browser's marker and the second pending cookie. */
    async function spendTwice() {
      const token = await currentJwt();
      const first = await fetchWorker("/store-handoff", handoffForm(token));
      const second = await fetchWorker("/store-handoff", handoffForm(token));
      return { marker: setCookie(first, "lv_store_browser")!, spent: setCookie(second, "lv_store_link")! };
    }

    it("reconnects from the browser that spent it, as after disconnecting and choosing Connect", async () => {
      const outcomes = spyOnOutcomes();
      const { marker, spent } = await spendTwice();

      const res = await fetchWorker("/store-handoff/continue", { cookies: [spent, marker, await sessionCookie(USER_ID)] });

      expect(res.headers.get("Location")).toBe("/?store=connected");
      expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(USER_ID);
      expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "store.handoff", result: "reused", reason: "same_browser" });
    });

    it("signs that browser straight in again once connected", async () => {
      await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
      const { marker, spent } = await spendTwice();

      const res = await fetchWorker("/store-handoff/continue", { cookies: [spent, marker] });

      expect(res.headers.get("Location")).toBe("/");
      expect((await verifySessionToken(SESSION_KEY, setCookie(res, SESSION_COOKIE_NAME)!.split("=")[1]))?.userId).toBe(USER_ID);
    });

    it("keeps the account waiting through a sign-in, proven, for that browser", async () => {
      const { marker, spent } = await spendTwice();

      const res = await fetchWorker("/store-handoff/continue", { cookies: [spent, marker] });

      expect(res.headers.get("Location")).toBe("/login?connect=store");
      expect(setCookie(res, "lv_store_link")).toMatch(new RegExp(`^lv_store_link=${CUSTOMER}\\.\\d+\\.[A-Za-z0-9_-]*\\.\\.`));
    });

    it("grants nothing to any other browser: the card for somebody signed in, the sign-in page saying why for anyone else", async () => {
      const outcomes = spyOnOutcomes();
      await linkStoreAccount(env, OTHER_ID, CUSTOMER, OTHER_ID);
      const { spent } = await spendTwice();
      const otherMarker = "lv_store_browser=" + "a".repeat(64);

      const signedIn = await fetchWorker("/store-handoff/continue", { cookies: [spent, otherMarker, await sessionCookie(USER_ID)] });
      expect(signedIn.headers.get("Location")).toBe("/");
      expect(setCookie(signedIn, SESSION_COOKIE_NAME)).toBeNull();
      expect(setCookie(signedIn, "lv_store_link")).toBe("lv_store_link=");

      const signedOut = await fetchWorker("/store-handoff/continue", { cookies: [spent] });
      expect(signedOut.headers.get("Location")).toBe("/login?store=spent");
      expect(setCookie(signedOut, SESSION_COOKIE_NAME)).toBeNull();
      expect(await (await fetchWorker("/login?store=spent")).text()).toContain("The store&#39;s link was already used a few minutes ago");
      expect(await (await fetchWorker("/login")).text()).not.toContain("already used a few minutes ago");
      expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "store.handoff", result: "refused", reason: "replayed" });
    });

    it("is never honoured at sign-in, nor shown there, without the continue step's check", async () => {
      const { spent } = await spendTwice();

      expect(await (await fetchWorker("/login?connect=store", { cookies: [spent] })).text()).not.toContain("Your store account uses");
      const app = new Hono<{ Bindings: typeof env }>();
      app.get("/", async (c) => c.text(await finishPendingStoreLink(c, USER_ID)));
      expect(await (await app.request("/", { headers: { Cookie: spent } }, env)).text()).toBe("none");
      expect(await userForStoreCustomer(env, CUSTOMER)).toBeNull();
    });
  });

  it("goes home when there is no genuine account waiting", async () => {
    const tampered = (await pending()).replace(`=${CUSTOMER}.`, "=999.");

    expect((await fetchWorker("/store-handoff/continue", { cookies: [tampered] })).headers.get("Location")).toBe("/");
    expect((await fetchWorker("/store-handoff/continue")).headers.get("Location")).toBe("/");
  });
});

describe("finishing at sign-in", () => {
  /** `finishPendingStoreLink`, as `/login/complete` calls it once a session is issued. */
  const signIn = (userId: number) => {
    const app = new Hono<{ Bindings: typeof env }>();
    app.get("/", async (c) => c.text(await finishPendingStoreLink(c, userId)));
    return app;
  };

  async function pending() {
    return setCookie(await fetchWorker("/store-handoff", handoffForm(await currentJwt())), "lv_store_link")!;
  }

  it("connects the account that was waiting, and nothing when none was", async () => {
    const cookie = await pending();
    const res = await signIn(USER_ID).request("/", { headers: { Cookie: cookie } }, env);

    expect(await res.text()).toBe("linked");
    expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(USER_ID);
    expect(await (await signIn(USER_ID).request("/", {}, env)).text()).toBe("none");
  });

  it("does not take an account somebody else connected in the meantime", async () => {
    const cookie = await pending();
    await linkStoreAccount(env, OTHER_ID, CUSTOMER, OTHER_ID);

    expect(await (await signIn(USER_ID).request("/", { headers: { Cookie: cookie } }, env)).text()).toBe("taken");
    expect((await userForStoreCustomer(env, CUSTOMER))?.id).toBe(OTHER_ID);
  });
});

describe("POST /store-account/disconnect", () => {
  it("lets a member disconnect their own", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    const res = await fetchWorker("/store-account/disconnect", {
      method: "POST",
      headers: { Origin: "https://card.losverd.es" },
      cookies: [await sessionCookie(USER_ID)],
    });

    expect(res.headers.get("Location")).toBe("/?store=disconnected");
    expect(await storeAccountFor(env, USER_ID)).toBeNull();
  });
});

describe("the app's callbacks", () => {
  it("completes an install for this store by exchanging the code, keeping nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "store-token", scope: "store_v2_customers_login" }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await fetchWorker(`/bigcommerce/app/auth?code=abc&scope=store_v2_customers_login&context=stores/${env.BIGCOMMERCE_STORE_HASH}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("installed");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(BIGCOMMERCE_TOKEN_URL);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: SECRET,
      code: "abc",
      grant_type: "authorization_code",
      redirect_uri: "https://card.losverd.es/bigcommerce/app/auth",
    });
  });

  it("refuses an install for another store, and reports a failed exchange", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 400 }));

    expect((await fetchWorker("/bigcommerce/app/auth?code=abc&context=stores/otherstore")).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await fetchWorker(`/bigcommerce/app/auth?code=abc&context=stores/${env.BIGCOMMERCE_STORE_HASH}`)).status).toBe(502);
  });

  it("shows the control panel what the app is for, and accepts an uninstall, only when signed by the store", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = encodeURIComponent(await signedPayload());
    const bad = encodeURIComponent(await signedPayload("stores/otherstore"));

    const load = await fetchWorker(`/bigcommerce/app/load?signed_payload_jwt=${good}`);
    expect(load.status).toBe(200);
    expect(await load.text()).toContain("nothing to configure");
    expect((await fetchWorker(`/bigcommerce/app/load?signed_payload_jwt=${bad}`)).status).toBe(403);
    expect((await fetchWorker(`/bigcommerce/app/uninstall?signed_payload_jwt=${good}`)).status).toBe(200);
    expect((await fetchWorker(`/bigcommerce/app/uninstall?signed_payload_jwt=${bad}`)).status).toBe(403);
  });

  it("are not there until the environment has an app", async () => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "";
    for (const path of ["/bigcommerce/app/auth?code=x", "/bigcommerce/app/load", "/bigcommerce/app/uninstall"]) {
      expect((await fetchWorker(path)).status).toBe(404);
    }
  });
});

describe("the member's page", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, user_id, auth_token, last_updated_at)
       VALUES ('LV-1', 'Jane', 'Doe', 'jane@example.com', '2099-01-01', '2021-01-01', ?, 'token', 1)`,
    )
      .bind(USER_ID)
      .run();
  });

  afterEach(async () => {
    await env.DB.exec("DELETE FROM members");
  });

  const page = async (query = "") => (await fetchWorker(`/${query}`, { cookies: [await sessionCookie(USER_ID)] })).text();

  it("offers to connect a store account, through the store's account page", async () => {
    const body = await page();

    expect(body).toContain("Store account");
    expect(body).toContain(`href="${STORE}/account.php#lv-connect"`);
  });

  it("says when it is connected, with a way to disconnect, and what just happened", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);

    const body = await page("?store=connected");

    expect(body).toContain("Your store account is connected.");
    expect(body).toContain('action="/store-account/disconnect"');
    expect(await page("?store=taken")).toContain("already connected to someone else");
  });

  it("names the connected account: its email, its customer number and since when", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID, "shopper@example.com");
    await env.DB.prepare("UPDATE users SET bigcommerce_linked_at = ? WHERE id = ?").bind(Date.UTC(2026, 9, 2, 12), USER_ID).run();

    expect(await page()).toContain(
      `Connected to <strong>shopper@example.com</strong> on the store (customer #${CUSTOMER}), since Oct 2, 2026.`,
    );
  });

  it("says where the email will come from when the store has not stated it yet", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    await env.DB.prepare("UPDATE users SET bigcommerce_linked_at = NULL WHERE id = ?").bind(USER_ID).run();

    const body = await page();

    expect(body).toContain(`Connected to store customer #${CUSTOMER}. Its email shows here once you next use`);
  });

  it("opens the connected store account, signed in, while store sign-in is on", async () => {
    await linkStoreAccount(env, USER_ID, CUSTOMER, USER_ID);
    const was = env.STORE_CUSTOMER_LOGIN;
    try {
      env.STORE_CUSTOMER_LOGIN = "on";
      const on = await page();
      expect(on).toContain('<a href="/store/go" class="action">Open my store account</a>');
      expect(on).toContain("and &quot;Open my store account&quot; takes you there, both without signing in again.");

      // Switched off, the same link would only reach the store's home page.
      env.STORE_CUSTOMER_LOGIN = "off";
      const off = await page();
      expect(off).not.toContain("Open my store account");
      expect(off).toContain("brings you straight here, without signing in again.");
    } finally {
      env.STORE_CUSTOMER_LOGIN = was;
    }
  });

  it("offers nothing to open before a store account is connected", async () => {
    const was = env.STORE_CUSTOMER_LOGIN;
    try {
      env.STORE_CUSTOMER_LOGIN = "on";
      expect(await page()).not.toContain("Open my store account");
    } finally {
      env.STORE_CUSTOMER_LOGIN = was;
    }
  });

  it("says nothing about store accounts until the environment has an app", async () => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "";
    expect(await page()).not.toContain("Store account");
  });
});
