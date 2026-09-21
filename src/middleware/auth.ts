/**
 * PassKit device-token authorization (the migration plan's Phase
 * 4.1/4.3/4.4): Apple devices authenticate to the web service
 * with `Authorization: ApplePass <authenticationToken>`, where the token is
 * the one baked into the member's `pass.json` at issuance
 * (`members.auth_token`). This file also holds Phase 2.3.4's
 * `requireAuth`/`requireAdmin`/`requireActiveMembership` member-session
 * middleware (per Phase 2.3.8 of the plan) -- unrelated concerns sharing one
 * file by convention (all "authorization middleware"), not by any shared
 * code.
 */

import { every } from "hono/combine";
import { createMiddleware } from "hono/factory";
import {
  clearSessionCookie,
  issueSessionToken,
  readSessionCookie,
  setSessionCookie,
  shouldRenewSession,
  verifySessionToken,
  type Session,
} from "../auth/session";
import type { Env } from "../index";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import { isUserBanned } from "../member/ban";

const AUTH_SCHEME_PREFIX = "ApplePass ";

/**
 * Verifies the incoming `Authorization: ApplePass <token>` header against a
 * member's stored `auth_token`. Apple's own examples use this exact,
 * case-sensitive scheme prefix (unlike BigCommerce's webhook auth, which
 * ported a legacy case-insensitive comparison from the Python app -- there's
 * no equivalent legacy PassKit implementation to match here).
 */
export function verifyPassAuthorization(
  authorizationHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith(AUTH_SCHEME_PREFIX)) return false;
  return timingSafeEqual(
    authorizationHeader.slice(AUTH_SCHEME_PREFIX.length),
    expectedToken,
  );
}

export const LOGIN_PATH = "/login";
/**
 * Why the login page is refusing. Named rather than generic: "that sign-in
 * didn't complete, try again" is the wrong thing to tell somebody who has
 * been expelled, and they would keep trying.
 */
export const BANNED_REASON = "account-blocked";
export const NO_ACTIVE_MEMBERSHIP_PATH = "/no-active-membership";

export type AuthEnv = {
  Bindings: Env;
  Variables: { session: Session };
};

async function loadUser(
  env: Env,
  userId: number,
): Promise<{ id: number; is_admin: number } | null> {
  return env.DB.prepare("SELECT id, is_admin FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: number; is_admin: number }>();
}

/**
 * Sends an unauthenticated visitor to log in, saying where they were sent
 * from.
 *
 * The marker is for us rather than for them. A bare `/login` is where every
 * unexplained sign-in problem ends up, and it looks identical whether the
 * member never signed in, or signed in perfectly and arrived holding a
 * session this app could not then read. Carrying the path they were bounced
 * off makes those two distinguishable from the address bar alone, without a
 * log tail.
 */
function redirectToLogin(c: {
  req: { path: string; url: string };
  redirect: (location: string) => Response;
}): Response {
  const search = new URL(c.req.url).search;
  const from = encodeURIComponent(`${c.req.path}${search}`);
  return c.redirect(`${LOGIN_PATH}?from=${from}`);
}

/**
 * Verifies the session cookie and sets `c.get("session")`, else redirects
 * to login. Mirrors the legacy `login_required`.
 *
 * No D1 read on the hot path -- except when the session is due for
 * sliding renewal, where the user is re-read rather than the old cookie's
 * claims being copied forward. Otherwise an active user's session (and its
 * `isAdmin` claim) would renew indefinitely after the account was deleted
 * or demoted.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const secret = c.env.SESSION_SIGNING_KEY;
  const token = readSessionCookie(c);
  let session = token ? await verifySessionToken(secret, token) : null;
  if (!session) {
    return redirectToLogin(c);
  }

  // Checked on every request rather than only when the session is renewed.
  // A ban that waited for renewal would leave somebody inside for as long as
  // their existing session lasted, which is the opposite of the point. Costs
  // one indexed lookup; `requireAdmin` already pays the same for its own
  // check.
  if (await isUserBanned(c.env, session.userId)) {
    clearSessionCookie(c);
    return c.redirect(`${LOGIN_PATH}?error=${BANNED_REASON}`);
  }

  let renewedToken: string | null = null;
  if (shouldRenewSession(session)) {
    const user = await loadUser(c.env, session.userId);
    if (!user) {
      clearSessionCookie(c);
      return redirectToLogin(c);
    }
    renewedToken = await issueSessionToken(secret, {
      userId: user.id,
      isAdmin: user.is_admin === 1,
    });
    session = (await verifySessionToken(secret, renewedToken)) as Session;
  }

  c.set("session", session);
  await next();
  if (renewedToken) {
    setSessionCookie(c, renewedToken);
  }
});

/**
 * `requireAuth` + an admin check against D1 (not just the cookie's
 * `isAdmin` claim, so demoting an admin takes effect immediately). Admin
 * routes are rare, so the extra read is negligible. Mirrors the legacy
 * `roles_required("admin")`.
 */
export const requireAdmin = every(
  requireAuth,
  createMiddleware<AuthEnv>(async (c, next) => {
    const user = await loadUser(c.env, c.get("session").userId);
    if (user?.is_admin !== 1) {
      return c.text("Forbidden", 403);
    }
    await next();
  }),
);

/**
 * `requireAuth` + at least one current membership for the user, else
 * redirect to the no-active-membership page. Mirrors the legacy
 * `active_membership_card_required`.
 *
 * Membership rows are matched by `members.user_id` *or* email, since
 * `members` rows are created by BigCommerce order sync, usually before any
 * login has linked them. A membership counts when it is good through today
 * and not revoked -- the rule `MEMBER_SELECT` resolves
 * (src/member/artifacts.ts), restated here because this asks "is there one"
 * across two ways of matching rather than loading a member. Somebody
 * expelled never gets this far: `requireAuth` has already refused them. A
 * new reason a membership stops counting belongs in both places.
 */
export const requireActiveMembership = every(
  requireAuth,
  createMiddleware<AuthEnv>(async (c, next) => {
    const today = new Date().toISOString().slice(0, 10);
    const membership = await c.env.DB.prepare(
      `SELECT 1 FROM members m JOIN users u ON u.id = ?
       WHERE (m.user_id = u.id OR m.email = u.email)
         AND m.expiration_date >= ?
         AND NOT EXISTS (SELECT 1 FROM revoked_cards r WHERE r.member_id = m.member_id)
       LIMIT 1`,
    )
      .bind(c.get("session").userId, today)
      .first();
    if (!membership) {
      return c.redirect(NO_ACTIVE_MEMBERSHIP_PATH);
    }
    await next();
  }),
);
