import { getAuthUser, initAuthConfig } from "@hono/auth-js";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import type { Env } from "../index";
import { LOGIN_PATH } from "../middleware/auth";
import { LV_USER_ID_CLAIM, authConfig } from "./authjs";
import { configuredProviders, renderLoginPage } from "./loginPage";
import {
  clearSessionCookie,
  issueSessionToken,
  setSessionCookie,
} from "./session";

const auth = new Hono<{ Bindings: Env }>();

/** Where Auth.js sends the browser after an OAuth sign-in completes. */
export const LOGIN_COMPLETE_PATH = "/login/complete";

// Both names Auth.js may use for its session cookie (`__Secure-` over HTTPS).
const AUTHJS_SESSION_COOKIES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
];

/**
 * Phase 2.3.2: where `requireAuth` sends logged-out users.
 *
 * This used to redirect straight to Auth.js's provider picker. It renders our
 * own page instead, because that redirect offered signing in and nothing
 * else: `/email-card` is public, is the answer for anyone without a Google or
 * Apple account (or with one under a different address), and was reachable
 * only by knowing the URL. The hand-off to Auth.js is unchanged -- the sign-in
 * link goes exactly where this redirect went.
 */
auth.get(LOGIN_PATH, (c) => {
  const signIn = new URL("/api/auth/signin", c.req.url);
  signIn.searchParams.set("callbackUrl", LOGIN_COMPLETE_PATH);
  return c.html(
    renderLoginPage({
      signInHref: signIn.pathname + signIn.search,
      providers: configuredProviders(c.env),
    }),
  );
});

/**
 * The session bridge: exchanges the Auth.js session from an OAuth sign-in
 * for this app's `lv_session`, then clears the Auth.js session so
 * `lv_session` is the only live session. The linked user id was stashed in
 * the Auth.js token at sign-in (src/auth/authjs.ts `jwt` callback); the user
 * is re-read here so a deleted account can't complete a login.
 */
auth.get(LOGIN_COMPLETE_PATH, initAuthConfig(authConfig), async (c) => {
  const authUser = await getAuthUser(c);
  const userId = authUser?.token?.[LV_USER_ID_CLAIM];
  const user =
    typeof userId === "number"
      ? await c.env.DB.prepare("SELECT id, is_admin FROM users WHERE id = ?")
          .bind(userId)
          .first<{ id: number; is_admin: number }>()
      : null;
  if (!user) {
    return c.redirect(LOGIN_PATH);
  }

  const token = await issueSessionToken(c.env.SESSION_SIGNING_KEY, {
    userId: user.id,
    isAdmin: user.is_admin === 1,
  });
  setSessionCookie(c, token);
  for (const name of AUTHJS_SESSION_COOKIES) {
    deleteCookie(c, name, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
  }
  return c.redirect("/");
});

/**
 * Phase 2.3.1: logout just clears `lv_session` (sessions are stateless, so
 * there's nothing server-side to revoke). POST-only with an Origin check, so
 * another site can't log a member out by embedding a link or form.
 */
auth.post("/logout", csrf(), (c) => {
  clearSessionCookie(c);
  return c.redirect("/", 303);
});

export default auth;
