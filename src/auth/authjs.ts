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
import { createMiddleware } from "hono/factory";
import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "../index";
import { linkOAuthUser } from "./oauth-link";

/**
 * Where Auth.js sends the browser once a sign-in finishes. Duplicated from
 * `routes.ts` rather than imported, because importing it the other way round
 * would be a cycle.
 */
export const POST_SIGN_IN_PATH = "/login/complete";

/** Auth.js's mount point, matching `basePath` below and the routes in `index.ts`. */
const AUTHJS_BASE_PATH = "/api/auth";

/**
 * Sends the browser to the session bridge once Auth.js's OAuth callback has
 * finished, whatever destination Auth.js settled on.
 *
 * The `redirect` callback below cannot do this on its own, which is not
 * obvious from Auth.js's documentation. Auth.js resolves the destination
 * once, on the *sign-in* route, and remembers it in a `callbackUrl` cookie;
 * the callback route then returns that cookie's value verbatim and never
 * consults `redirect` again. Apple returns by a cross-site POST
 * (`response_mode=form_post`), for which Auth.js relaxes only its `state`
 * and `nonce` cookies to `SameSite=None` -- `callbackUrl` stays `Lax`, so
 * the browser does not send it, and the destination falls back to the site
 * root. The root requires a session this app has not issued yet (the bridge
 * is what issues it), so the member was bounced to the login page looking as
 * though the sign-in had done nothing at all. Google, returning by a
 * same-site GET, was unaffected. Observed on staging 2026-09-19.
 *
 * Rewriting the finished response covers every provider and response mode
 * without depending on which cookies survive the trip. Auth.js's own pages
 * are left alone: a failed login redirects to its error or sign-in screen,
 * and those are the responses that say why it stopped. Off-site destinations
 * are left alone too, so this only ever redirects further into this app.
 *
 * Headers are edited in place rather than copied onto a new response: the
 * success path is carrying the `Set-Cookie` that *is* the sign-in, and
 * rebuilding a response risks collapsing repeated `Set-Cookie` headers.
 */
export const landOnSessionBridge = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    await next();
    const location = c.res.headers.get("Location");
    if (!location) return;
    const origin = new URL(c.req.url).origin;
    const destination = new URL(location, origin);
    if (destination.origin !== origin) return;
    if (destination.pathname.startsWith(`${AUTHJS_BASE_PATH}/`)) return;
    c.res.headers.set("Location", `${origin}${POST_SIGN_IN_PATH}`);
  },
);

const APPLE_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/** Claim in the Auth.js token carrying the linked `users.id`. */
export const LV_USER_ID_CLAIM = "lvUserId";

/**
 * Claim carrying which provider the sign-in came through (`google`, `apple`),
 * so the session bridge can say so in its outcome line -- the bridge sees the
 * finished session, not the OAuth exchange that produced it.
 */
export const LV_PROVIDER_CLAIM = "lvProvider";

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
       * Pins the destination Auth.js stores at sign-in to the session
       * bridge, which is the only sensible landing place: it is what turns
       * an Auth.js session into this app's own, and where a failure gets
       * reported. Ignoring the URL it is handed also means a crafted
       * `?callbackUrl=` cannot send a member anywhere else.
       *
       * This is not what makes the browser arrive there, though it reads
       * like it should be -- Auth.js does not consult this callback when the
       * OAuth callback finishes. `landOnSessionBridge` above is what
       * actually lands the member on the bridge, and explains why.
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
          token[LV_PROVIDER_CLAIM] = account.provider;
        }
        return token;
      },
    },
  };
}
