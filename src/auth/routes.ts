import { Hono } from "hono";
import type { Env } from "../index";
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

export default auth;
