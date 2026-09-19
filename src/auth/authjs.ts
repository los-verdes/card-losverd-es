/**
 * OAuth login via Auth.js (the migration plan's Phase 2.3.2), mounted at
 * `/api/auth/*` by `src/index.ts`. Auth.js owns the protocol details: the
 * state/nonce/PKCE checks, ID token verification, and Apple's cross-site
 * `form_post` callback.
 *
 * Auth.js's session is only a stepping stone to this app's own `lv_session`
 * (the "bridge"): the `jwt` callback links the login to a `users` row and
 * stashes its id in the Auth.js token, then `GET /login/complete`
 * (src/auth/routes.ts) exchanges that for `lv_session` and clears the
 * Auth.js cookie. The rest of the app (`requireAuth`) only ever deals with
 * `lv_session`.
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
import { linkOAuthUser } from "./oauth-link";

/**
 * Where Auth.js sends the browser once a sign-in finishes. Duplicated from
 * `routes.ts` rather than imported, because importing it the other way round
 * would be a cycle.
 */
export const POST_SIGN_IN_PATH = "/login/complete";

const APPLE_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/** Claim in the Auth.js token carrying the linked `users.id`. */
export const LV_USER_ID_CLAIM = "lvUserId";

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

/**
 * The user's real name, if the provider gave one. Auth.js's Apple provider
 * falls back to the email address as `name` (Apple only sends a name on a
 * user's very first authorization), which isn't a name worth storing.
 */
export function providerFullName(user: {
  name?: string | null;
  email?: string | null;
}): string | null {
  return user.name && user.name !== user.email ? user.name : null;
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
    // Unlike Google's static secret, Apple's is minted here, so a malformed
    // key throws while the config is being assembled. Left uncaught that took
    // down every route under /api/auth -- including Google sign-in, and
    // including the page that would have explained itself -- so one unusable
    // optional credential locked everyone out (seen on staging 2026-09-17).
    // Offering one working provider beats offering none.
    try {
      providers.push(
        Apple({
          clientId: env.AUTH_APPLE_ID,
          clientSecret: await appleClientSecret(env),
        }),
      );
    } catch (error) {
      console.error(
        "authConfig(): Sign in with Apple unavailable -- APPLE_SIGNIN_PRIVATE_KEY_PEM could not sign a client secret",
        error,
      );
    }
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
      /**
       * Always the session bridge, rather than wherever Auth.js would
       * otherwise go.
       *
       * Auth.js remembers the requested destination in a `callbackUrl`
       * cookie, which is `SameSite=Lax`. Apple returns via a cross-site POST
       * (`response_mode=form_post`), and a Lax cookie is not sent on one --
       * so for Apple the destination was forgotten and Auth.js fell back to
       * the site root. That needs a session this app hasn't issued yet,
       * which bounced the member to the login page looking as though nothing
       * had happened. Google was unaffected, returning by a same-site GET.
       *
       * Naming the destination here removes the dependency on that cookie
       * entirely, for every provider and whatever Auth.js decides its
       * default should be in future. The bridge is the only sensible landing
       * place regardless: it is what turns an Auth.js session into this
       * app's own, and it is where a failure gets reported.
       */
      redirect: ({ baseUrl }) => `${baseUrl}${POST_SIGN_IN_PATH}`,
      // `account` is only present on the sign-in itself, so linking runs once
      // per OAuth login rather than on every session read.
      async jwt({ token, account, user }) {
        if (account) {
          const linked = await linkOAuthUser(env, {
            provider: account.provider,
            providerUserId: account.providerAccountId,
            email: user.email!,
            fullName: providerFullName(user),
          });
          token[LV_USER_ID_CLAIM] = linked.id;
        }
        return token;
      },
    },
  };
}
