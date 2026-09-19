import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import {
  SignJWT,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appleClientSecret, authConfig, isVerifiedEmailProfile, providerFullName } from "../../src/auth/authjs";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../../src/auth/session";
import worker from "../../src/index";

const ORIGIN = "https://card.losverd.es";
const SESSION_KEY = "test-session-signing-key-0123456789";
let applePrivateKeyPem: string;
let applePublicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  applePrivateKeyPem = await exportPKCS8(pair.privateKey);
  applePublicKey = pair.publicKey;
});

beforeEach(() => {
  env.AUTH_SECRET = "test-auth-secret-0123456789abcdef0123456789";
  env.AUTH_GOOGLE_ID = "google-client-id";
  env.AUTH_GOOGLE_SECRET = "google-client-secret";
  env.AUTH_APPLE_ID = "es.losverd.card";
  env.APPLE_SIGNIN_TEAM_ID = "KJHZP635V9";
  env.APPLE_SIGNIN_KEY_ID = "APPLEKEY01";
  env.APPLE_SIGNIN_PRIVATE_KEY_PEM = applePrivateKeyPem;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM oauth_identities");
  await env.DB.exec("DELETE FROM users");
});

/** Minimal cookie jar: collects Set-Cookie name=value pairs across responses. */
class CookieJar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const eq = pair.indexOf("=");
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  names(): string[] {
    return [...this.cookies.keys()];
  }
}

async function request(path: string, init: RequestInit = {}, jar?: CookieJar) {
  const headers = new Headers(init.headers);
  if (jar) headers.set("Cookie", jar.header());
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }), env, createExecutionContext());
  jar?.store(res);
  return res;
}

async function startSignIn(provider: string, jar: CookieJar, callbackUrl = `${ORIGIN}/`) {
  const csrf = await request("/api/auth/csrf", {}, jar);
  const { csrfToken } = await csrf.json<{ csrfToken: string }>();
  return request(
    `/api/auth/signin/${provider}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, callbackUrl }),
    },
    jar,
  );
}

const GOOGLE_DISCOVERY = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
};

const APPLE_DISCOVERY = {
  issuer: "https://appleid.apple.com",
  authorization_endpoint: "https://appleid.apple.com/auth/authorize",
  token_endpoint: "https://appleid.apple.com/auth/token",
  jwks_uri: "https://appleid.apple.com/auth/keys",
};

describe("appleClientSecret", () => {
  it("mints a short-lived ES256 client secret JWT per Apple's spec", async () => {
    const token = await appleClientSecret(env, 1_800_000_000);

    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "APPLEKEY01" });
    const { payload } = await jwtVerify(token, applePublicKey, {
      currentDate: new Date(1_800_000_000 * 1000),
    });
    expect(payload).toEqual({
      iss: "KJHZP635V9",
      sub: "es.losverd.card",
      aud: "https://appleid.apple.com",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
    });
  });

  it("defaults to the current time", async () => {
    await expect(jwtVerify(await appleClientSecret(env), applePublicKey)).resolves.toBeTruthy();
  });
});

describe("isVerifiedEmailProfile", () => {
  it.each<[string, Record<string, unknown> | undefined, boolean]>([
    ["Google boolean true", { email: "a@example.com", email_verified: true }, true],
    ["Apple string 'true'", { email: "a@example.com", email_verified: "true" }, true],
    ["unverified", { email: "a@example.com", email_verified: false }, false],
    ["Apple string 'false'", { email: "a@example.com", email_verified: "false" }, false],
    ["missing email_verified", { email: "a@example.com" }, false],
    ["missing email", { email_verified: true }, false],
    ["no profile", undefined, false],
  ])("%s -> %s", (_label, profile, expected) => {
    expect(isVerifiedEmailProfile(profile)).toBe(expected);
  });
});

describe("providerFullName", () => {
  it("keeps a real name", () => {
    expect(providerFullName({ name: "Jane Doe", email: "jane@example.com" })).toBe("Jane Doe");
  });

  it("drops Auth.js's email-as-name fallback (Apple without a name) and missing names", () => {
    expect(providerFullName({ name: "jane@example.com", email: "jane@example.com" })).toBeNull();
    expect(providerFullName({ name: null, email: "jane@example.com" })).toBeNull();
    expect(providerFullName({ email: "jane@example.com" })).toBeNull();
  });
});

describe("/api/auth (Auth.js)", () => {
  it("offers only the providers whose config is set", async () => {
    const both = await request("/api/auth/providers");
    expect(Object.keys(await both.json())).toEqual(["google", "apple"]);

    env.APPLE_SIGNIN_PRIVATE_KEY_PEM = undefined;
    env.AUTH_GOOGLE_SECRET = undefined;
    const none = await request("/api/auth/providers");
    expect(await none.json()).toEqual({});
  });

  it("keeps Google working when the Apple key is unusable", async () => {
    // A .p8 mangled on its way into the secret store: well-formed PEM
    // markers, contents that can't be decoded. This once 500'd every route
    // under /api/auth, so nobody could log in by any means.
    env.APPLE_SIGNIN_PRIVATE_KEY_PEM =
      "-----BEGIN PRIVATE KEY-----not base64 at all-----END PRIVATE KEY-----";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request("/api/auth/providers");

    expect(res.status).toBe(200);
    expect(Object.keys(await res.json())).toEqual(["google"]);
    expect(errors).toHaveBeenCalled();
    // The key itself must not reach the logs.
    expect(JSON.stringify(errors.mock.calls)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("fails closed without AUTH_SECRET", async () => {
    env.AUTH_SECRET = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request("/api/auth/providers");
    expect(res.status).toBe(500);
  });

  it("starts a Google sign-in with PKCE", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://accounts.google.com/.well-known/openid-configuration") {
        return Response.json(GOOGLE_DISCOVERY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const jar = new CookieJar();

    const res = await startSignIn("google", jar);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(GOOGLE_DISCOVERY.authorization_endpoint);
    expect(location.searchParams.get("client_id")).toBe("google-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("starts an Apple sign-in with form_post, sending state/nonce cookies as SameSite=None", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://appleid.apple.com/.well-known/openid-configuration") {
        return Response.json(APPLE_DISCOVERY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const jar = new CookieJar();

    const res = await startSignIn("apple", jar);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("response_mode")).toBe("form_post");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    const crossSiteCookies = res.headers.getSetCookie().filter((c) => /authjs\.(state|nonce)=/.test(c));
    expect(crossSiteCookies).toHaveLength(2);
    for (const cookie of crossSiteCookies) {
      expect(cookie).toMatch(/SameSite=None/i);
      expect(cookie).toMatch(/Secure/i);
    }
  });

  describe("Google callback round trip", () => {
    async function runGoogleLogin(claims: Record<string, unknown>, callbackUrl = `${ORIGIN}/`) {
      const idpKeys = await generateKeyPair("RS256", { extractable: true });
      const jwk = { ...(await exportJWK(idpKeys.publicKey)), kid: "google-test-key", alg: "RS256", use: "sig" };
      vi.spyOn(console, "error").mockImplementation(() => {});

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://accounts.google.com/.well-known/openid-configuration") {
          return Response.json(GOOGLE_DISCOVERY);
        }
        if (url === GOOGLE_DISCOVERY.jwks_uri) {
          return Response.json({ keys: [jwk] });
        }
        if (url === GOOGLE_DISCOVERY.token_endpoint) {
          const idToken = await new SignJWT({ email: "jane@example.com", ...claims })
            .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
            .setIssuer("https://accounts.google.com")
            .setAudience("google-client-id")
            .setSubject("google-user-123")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(idpKeys.privateKey);
          return Response.json({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: idToken,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const jar = new CookieJar();
      const start = await startSignIn("google", jar, callbackUrl);
      const state = new URL(start.headers.get("Location")!).searchParams.get("state");
      const callback = await request(
        `/api/auth/callback/google?code=auth-code&state=${state}`,
        {},
        jar,
      );
      return { callback, jar };
    }

    it("issues an Auth.js session for a verified Google email, landing on the bridge", async () => {
      // The destination is the bridge for every provider now, rather than
      // whatever the `callbackUrl` cookie survived to say -- for Apple it
      // did not survive at all, being SameSite=Lax across a cross-site POST.
      const { callback, jar } = await runGoogleLogin({ email_verified: true });

      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe(`${ORIGIN}/login/complete`);
      expect(jar.names()).toContain("__Secure-authjs.session-token");

      const session = await request("/api/auth/session", {}, jar);
      expect(await session.json()).toMatchObject({ user: { email: "jane@example.com" } });
    });

    it("refuses an unverified Google email", async () => {
      const { callback, jar } = await runGoogleLogin({ email_verified: false });

      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toContain("error=AccessDenied");
      expect(jar.names()).not.toContain("__Secure-authjs.session-token");
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
    });

    describe("session bridge to lv_session", () => {
      beforeEach(() => {
        env.SESSION_SIGNING_KEY = SESSION_KEY;
      });

      function lvSessionToken(res: Response): string | undefined {
        return res.headers
          .getSetCookie()
          .map((c) => c.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`))?.[1])
          .find(Boolean);
      }

      it("GET /login offers Auth.js's sign-in page, still returning to the bridge", async () => {
        // The hand-off is what it always was; only the page in front of it
        // is new, so this asserts the link rather than a redirect.
        const res = await request("/login");

        expect(res.status).toBe(200);
        expect(await res.text()).toContain(
          'href="/api/auth/signin?callbackUrl=%2Flogin%2Fcomplete"',
        );
      });

      it("GET /login offers the email route, for someone who won't be signing in", async () => {
        // The reason this page exists: /email-card is public and is the whole
        // answer for a member with no Google or Apple account, and it used to
        // be reachable only by knowing the URL.
        expect(await (await request("/login")).text()).toContain('href="/email-card"');
      });

      it("links a new user on sign-in, then exchanges the Auth.js session for lv_session", async () => {
        const { callback, jar } = await runGoogleLogin({ email_verified: true, name: "Jane Doe" }, `${ORIGIN}/login/complete`);
        expect(callback.headers.get("Location")).toBe(`${ORIGIN}/login/complete`);

        const user = await env.DB.prepare("SELECT id, email, full_name FROM users").first<{
          id: number;
          email: string;
          full_name: string;
        }>();
        expect(user).toMatchObject({ email: "jane@example.com", full_name: "Jane Doe" });
        expect(
          await env.DB.prepare("SELECT user_id, provider, provider_user_id FROM oauth_identities").first(),
        ).toEqual({ user_id: user!.id, provider: "google", provider_user_id: "google-user-123" });

        const complete = await request("/login/complete", {}, jar);

        expect(complete.status).toBe(302);
        expect(complete.headers.get("Location")).toBe("/");
        const session = await verifySessionToken(SESSION_KEY, lvSessionToken(complete)!);
        expect(session).toMatchObject({ userId: user!.id, isAdmin: false });
        // The Auth.js session is cleared, leaving lv_session as the only live session.
        expect(complete.headers.getSetCookie()).toContainEqual(
          expect.stringMatching(/^__Secure-authjs\.session-token=;.*Max-Age=0/),
        );
      });

      it("links to an existing user by email, preserving their admin flag", async () => {
        await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (77, 'jane@example.com', 1)").run();

        const { jar } = await runGoogleLogin({ email_verified: true }, `${ORIGIN}/login/complete`);
        const complete = await request("/login/complete", {}, jar);

        expect(await verifySessionToken(SESSION_KEY, lvSessionToken(complete)!)).toMatchObject({
          userId: 77,
          isAdmin: true,
        });
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 1 });
      });

      it("redirects to /login without a valid Auth.js session, saying which", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const res = await request("/login/complete", { headers: { Cookie: "__Secure-authjs.session-token=forged" } });
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/login?error=no-authjs-session");
        expect(lvSessionToken(res)).toBeUndefined();
      });

      it("redirects to /login if the linked user was deleted before the bridge ran, saying which", async () => {
        // Distinct from the case above on purpose: a deleted account and an
        // unreadable cookie want completely different investigations.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { jar } = await runGoogleLogin({ email_verified: true }, `${ORIGIN}/login/complete`);
        await env.DB.exec("DELETE FROM users");

        const res = await request("/login/complete", {}, jar);

        expect(res.headers.get("Location")).toBe("/login?error=linked-user-missing");
        expect(lvSessionToken(res)).toBeUndefined();
      });
    });
  });
});

describe("the login page", () => {
  async function loginHtml() {
    return (await request("/login")).text();
  }

  it("names only the providers that are configured", async () => {
    expect(await loginHtml()).toContain("Sign in with Google or Apple");

    env.APPLE_SIGNIN_PRIVATE_KEY_PEM = undefined;

    expect(await loginHtml()).toContain("Sign in with Google");
    expect(await loginHtml()).not.toContain("or Apple");
  });

  it("still offers the email route when no provider is configured at all", async () => {
    // The worst case for a member, and the one where the alternative matters
    // most: nothing to sign in with, but their card is still reachable.
    env.AUTH_GOOGLE_SECRET = undefined;
    env.APPLE_SIGNIN_PRIVATE_KEY_PEM = undefined;

    const html = await loginHtml();

    expect(html).toContain("Signing in is unavailable");
    expect(html).toContain('href="/email-card"');
  });

  it("carries the group's branding, unlike the page it replaced", async () => {
    expect(await loginHtml()).toContain('<link rel="stylesheet" href="/assets/app.css"');
  });
});

describe("the session bridge's failure modes", () => {
  // These three used to be one silent redirect, which is why "Apple login is
  // broken" could not be narrowed without guessing.
  it("names a missing Auth.js session, the cookie case", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request("/login/complete");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=no-authjs-session");
    expect(warn).toHaveBeenCalledWith("login bridge: not completing sign-in", {
      reason: "no-authjs-session",
    });
  });

  it("tells the member their sign-in didn't complete, rather than looking like nothing happened", async () => {
    const html = await (await request("/login?error=no-authjs-session")).text();

    expect(html).toContain("Trying again often works");
    expect(html).toContain('href="/email-card"');
  });

  it("says nothing of the sort on an ordinary visit", async () => {
    expect(await (await request("/login")).text()).not.toContain("Trying again often works");
  });
});

describe("where Auth.js sends the browser after signing in", () => {
  async function redirectTo(url: string) {
    const config = await authConfig({ env } as unknown as Parameters<typeof authConfig>[0]);
    return config.callbacks!.redirect!({ url, baseUrl: ORIGIN });
  }

  it("always lands on the session bridge, whatever it is handed", async () => {
    // Apple returns by cross-site POST, so the `callbackUrl` cookie Auth.js
    // would otherwise consult (SameSite=Lax) isn't sent, and the destination
    // fell back to the site root -- which needs a session not issued yet, so
    // the member bounced back to the login page as if nothing had happened.
    await expect(redirectTo(`${ORIGIN}/`)).resolves.toBe(`${ORIGIN}/login/complete`);
    await expect(redirectTo(`${ORIGIN}/login/complete`)).resolves.toBe(`${ORIGIN}/login/complete`);
  });

  it("ignores an off-site destination rather than honouring it", async () => {
    await expect(redirectTo("https://example.invalid/steal")).resolves.toBe(
      `${ORIGIN}/login/complete`,
    );
  });
});
