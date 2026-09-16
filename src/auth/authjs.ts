/**
 * OAuth login via Auth.js (the migration plan's Phase 2.3.2), mounted at
 * `/api/auth/*` by `src/index.ts`. Auth.js owns the protocol details: the
 * state/nonce/PKCE checks, ID token verification, and Apple's cross-site
 * `form_post` callback.
 *
 * Deliberately not yet integrated with this app's own session: a login
 * produces an Auth.js session cookie, which `requireAuth` (`lv_session`)
 * doesn't read. Linking to `users`/`oauth_identities` and that session
 * bridge are follow-ups.
 *
 * Providers are only offered once their config is set (via `wrangler secret
 * put`), so an unconfigured provider can't start a login.
 */

import type { AuthConfig } from "@auth/core";
import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import type { Provider } from "@auth/core/providers";
import type { Context } from "hono";
import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "../index";

const APPLE_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/**
 * Apple has no static client secret: it's an ES256 JWT signed with the Sign
 * in with Apple key. Auth.js expects a pre-generated one (valid for at most
 * six months); minting a short-lived one per request instead avoids a
 * rotation chore.
 */
export async function appleClientSecret(
  env: Env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await importPKCS8(env.APPLE_SIGNIN_PRIVATE_KEY_PEM!, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_SIGNIN_KEY_ID })
    .setIssuer(env.APPLE_SIGNIN_TEAM_ID)
    .setSubject(env.AUTH_APPLE_ID)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + APPLE_CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

/**
 * Accounts will be matched to members by email, so only accept logins whose
 * email the provider has verified. Apple sends `email_verified` as the
 * string `"true"`; Google sends a boolean.
 */
export function isVerifiedEmailProfile(
  profile: Record<string, unknown> | undefined,
): boolean {
  return (
    typeof profile?.email === "string" &&
    (profile.email_verified === true || profile.email_verified === "true")
  );
}

export async function authConfig(
  c: Context<{ Bindings: Env }>,
): Promise<AuthConfig> {
  const env = c.env;
  const providers: Provider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: env.AUTH_GOOGLE_ID,
        clientSecret: env.AUTH_GOOGLE_SECRET,
      }),
    );
  }
  if (env.APPLE_SIGNIN_KEY_ID && env.APPLE_SIGNIN_PRIVATE_KEY_PEM) {
    providers.push(
      Apple({
        clientId: env.AUTH_APPLE_ID,
        clientSecret: await appleClientSecret(env),
      }),
    );
  }

  return {
    secret: env.AUTH_SECRET,
    basePath: "/api/auth",
    // Workers sit behind Cloudflare's own edge, so the request host is
    // trustworthy; callback URLs are derived from it.
    trustHost: true,
    session: { strategy: "jwt" },
    providers,
    callbacks: {
      signIn: ({ profile }) => isVerifiedEmailProfile(profile),
    },
  };
}
