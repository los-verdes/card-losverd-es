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
import { appleClientSecret, isVerifiedEmailProfile } from "../../src/auth/authjs";
import worker from "../../src/index";

const ORIGIN = "https://card.losverd.es";
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

afterEach(() => {
  vi.restoreAllMocks();
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

async function startSignIn(provider: string, jar: CookieJar) {
  const csrf = await request("/api/auth/csrf", {}, jar);
  const { csrfToken } = await csrf.json<{ csrfToken: string }>();
  return request(
    `/api/auth/signin/${provider}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${ORIGIN}/` }),
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

describe("/api/auth (Auth.js)", () => {
  it("offers only the providers whose config is set", async () => {
    const both = await request("/api/auth/providers");
    expect(Object.keys(await both.json())).toEqual(["google", "apple"]);

    env.APPLE_SIGNIN_PRIVATE_KEY_PEM = undefined;
    env.AUTH_GOOGLE_SECRET = undefined;
    const none = await request("/api/auth/providers");
    expect(await none.json()).toEqual({});
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
    async function runGoogleLogin(claims: Record<string, unknown>) {
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
      const start = await startSignIn("google", jar);
      const state = new URL(start.headers.get("Location")!).searchParams.get("state");
      const callback = await request(
        `/api/auth/callback/google?code=auth-code&state=${state}`,
        {},
        jar,
      );
      return { callback, jar };
    }

    it("issues an Auth.js session for a verified Google email", async () => {
      const { callback, jar } = await runGoogleLogin({ email_verified: true });

      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe(`${ORIGIN}/`);
      expect(jar.names()).toContain("__Secure-authjs.session-token");

      const session = await request("/api/auth/session", {}, jar);
      expect(await session.json()).toMatchObject({ user: { email: "jane@example.com" } });
    });

    it("refuses an unverified Google email", async () => {
      const { callback, jar } = await runGoogleLogin({ email_verified: false });

      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toContain("error=AccessDenied");
      expect(jar.names()).not.toContain("__Secure-authjs.session-token");
    });
  });
});
