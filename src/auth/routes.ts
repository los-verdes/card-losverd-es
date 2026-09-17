import { getAuthUser, initAuthConfig } from "@hono/auth-js";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Env } from "../index";
import { LOGIN_PATH } from "../middleware/auth";
import { LV_USER_ID_CLAIM, authConfig } from "./authjs";
import {
  upsertUserFromStorefrontCustomer,
  verifyStorefrontCustomerJwt,
} from "./bigcommerce-sso";
import { issueSessionToken, setSessionCookie } from "./session";

const auth = new Hono<{ Bindings: Env }>();

/**
 * Phase 2.3.3: BigCommerce storefront -> member portal login handoff.
 * Mirrors the legacy `login_via_bigcommerce`.
 */
auth.get("/storefront/:storeHash/members/:jwt/login", async (c) => {
  const { storeHash, jwt } = c.req.param();
  const customer = await verifyStorefrontCustomerJwt(c.env, storeHash, jwt);
  if (!customer) {
    return c.text("Unauthorized", 401);
  }

  const user = await upsertUserFromStorefrontCustomer(c.env, customer);
  const token = await issueSessionToken(c.env.SESSION_SIGNING_KEY, {
    userId: user.id,
    isAdmin: user.is_admin === 1,
  });
  setSessionCookie(c, token);
  return c.redirect("/");
});

/** Where Auth.js sends the browser after an OAuth sign-in completes. */
export const LOGIN_COMPLETE_PATH = "/login/complete";

// Both names Auth.js may use for its session cookie (`__Secure-` over HTTPS).
const AUTHJS_SESSION_COOKIES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
];

/**
 * Phase 2.3.2: where `requireAuth` sends logged-out users. Hands off to
 * Auth.js's provider picker, returning to the session bridge afterwards.
 */
auth.get(LOGIN_PATH, (c) => {
  const signIn = new URL("/api/auth/signin", c.req.url);
  signIn.searchParams.set("callbackUrl", LOGIN_COMPLETE_PATH);
  return c.redirect(signIn.pathname + signIn.search);
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

export default auth;
