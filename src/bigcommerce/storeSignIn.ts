/**
 * The store from the card site (#38, Phase 3): links on the card site that
 * go to the store signed in, for a member whose store account is connected.
 *
 * `GET /store/go` (`?to=renew` for the membership page) answers with a
 * redirect. For somebody signed in here whose store account is connected
 * (`users.bigcommerce_id`, made only by the store handoff), it goes through
 * BigCommerce's Customer Login API: a JWT naming that customer, signed with
 * the app's client secret, minted per click, good for 30 seconds and once,
 * and never stored or logged. Anyone else -- signed out, not connected,
 * barred, or in an environment without a store app -- is sent to the same
 * page of the store, signed in or not as the store already has them.
 *
 * It can be followed from anywhere, as a plain link. The worst another site
 * can do with it is sign a member in to their own store account, which also
 * ends any other store session of theirs (as BigCommerce documents).
 */

import { Hono, type Context } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../index";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import { isUserExpelled } from "../member/expulsion";
import { STORE_GO_PATH, storeHomeUrl } from "../member/storeReturn";
import { recordOutcome } from "../lib/outcome";
import { appConfig, type AppConfig } from "./appJwt";
import { storeAccountFor } from "./storeAccount";

/** Where on the store each destination lands. */
const DESTINATIONS = { shop: "/", renew: "/membership/" } as const;
type Destination = keyof typeof DESTINATIONS;

function destination(value: string | undefined): Destination {
  return value === "renew" ? "renew" : "shop";
}

/**
 * The store's Customer Login address for one customer: the store's
 * `/login/token/<jwt>`, signed in and then sent on to `redirectTo` (a path
 * on the store).
 */
export async function customerLoginUrl(
  app: AppConfig,
  storeUrl: string,
  customerId: number,
  redirectTo: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const jwt = await new SignJWT({
    operation: "customer_login",
    store_hash: app.storeHash,
    customer_id: customerId,
    redirect_to: redirectTo,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(app.clientId)
    .setIssuedAt(nowSeconds)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(app.clientSecret));
  return new URL(`/login/token/${jwt}`, storeUrl).toString();
}

/** The store customer to sign in as, for this request: connected, signed in here, and not barred. */
async function connectedCustomer(c: Context<{ Bindings: Env }>): Promise<number | null> {
  const token = readSessionCookie(c);
  const session = token ? await verifySessionToken(c.env.SESSION_SIGNING_KEY, token) : null;
  if (!session || (await isUserExpelled(c.env, session.userId))) return null;
  return (await storeAccountFor(c.env, session.userId))?.customerId ?? null;
}

const storeSignIn = new Hono<{ Bindings: Env }>();

storeSignIn.get(STORE_GO_PATH, async (c) => {
  const to = destination(c.req.query("to"));
  const store = storeHomeUrl(c.env);
  const plain = new URL(DESTINATIONS[to], store).toString();
  const app = appConfig(c.env);
  const customerId = app ? await connectedCustomer(c) : null;
  c.header("Cache-Control", "no-store");
  if (app === null || customerId === null) {
    recordOutcome("store.sign_in", { result: "plain", to });
    return c.redirect(plain, 302);
  }
  recordOutcome("store.sign_in", { result: "signed_in", to });
  return c.redirect(await customerLoginUrl(app, store, customerId, DESTINATIONS[to]), 302);
});

export default storeSignIn;
