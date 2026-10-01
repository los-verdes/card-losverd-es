/**
 * The store handoff (#38, Phase 1): "Membership card" on the store signs a
 * member in here, connecting their store account the first time.
 *
 * The storefront script fetches the store's `current.jwt` and submits it as a
 * top-level form POST to `/store-handoff`. That request is cross-site, so the
 * card site's own `lv_session` cookie (SameSite=Lax) does not come with it.
 * So the POST only verifies the token, spends it (each is accepted once), and
 * keeps the verified customer in a short-lived signed cookie, then sends the
 * browser on to `GET /store-handoff/continue`. That is a top-level GET, on
 * which both cookies arrive, and it decides:
 *
 * - a store account already connected: sign in as its user;
 * - not connected, and signed in here: connect it to that user;
 * - not connected and not signed in: sign in once with Google or Apple, and
 *   the connection is made at `/login/complete` (`finishPendingStoreLink`).
 *
 * The store hands out the same token for its whole 15 minutes, however it is
 * fetched (checked on staging, 2026-09-30), so a second "Membership card"
 * within that time arrives with a spent token. The browser that spent it was
 * given a random marker cookie at the time (`lv_store_browser`), and a spent
 * token is honoured only from the browser holding that marker: the same
 * member coming back, not somebody holding a copy. Without it, a spent token
 * grants nothing: it shows the card to somebody still signed in here, or the
 * sign-in page, saying why, to anyone else.
 *
 * Orders are never consulted, and the store's email is never matched: see
 * src/bigcommerce/storeAccount.ts.
 */

import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import { csrf } from "hono/csrf";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../index";
import { LOGIN_PATH, EXPELLED_REASON, requireAuth, type AuthEnv } from "../middleware/auth";
import { isUserExpelled } from "../member/expulsion";
import { Page, SUPPORT_EMAIL } from "../member/layout";
import { recordOutcome } from "../lib/outcome";
import { issueSessionToken, readSessionCookie, setSessionCookie, verifySessionToken } from "../auth/session";
import { AppJwtRejected, appConfig, verifyCurrentCustomer } from "./appJwt";
import {
  StoreAccountTaken,
  claimHandoffToken,
  handoffTokenHeldBy,
  linkStoreAccount,
  unlinkStoreAccount,
  userForStoreCustomer,
} from "./storeAccount";

export const STORE_HANDOFF_PATH = "/store-handoff";
export const STORE_HANDOFF_CONTINUE_PATH = "/store-handoff/continue";
export const STORE_DISCONNECT_PATH = "/store-account/disconnect";

/**
 * Any request context whose bindings are this Worker's: the handoff's own
 * routes, and `/login/complete`, whose apps declare different variables.
 */
type HandoffContext = Context;

/** The Worker's bindings, from a context whose type doesn't carry them. */
const envOf = (c: HandoffContext): Env => c.env as Env;

/**
 * The verified store customer waiting to be connected, across the redirect
 * and any sign-in: `<customer id>.<expires ms>.<store email, base64url>.<spent token hash>.<hmac>`.
 * The email is only shown back to them, as a hint of which account to sign
 * in with; it never decides anything. A spent token hash marks one set by a
 * token already used: it counts for nothing until `/store-handoff/continue`
 * has seen the browser's marker, and nowhere else at all.
 */
const PENDING_COOKIE = "lv_store_link";

/**
 * A random marker given to the browser that first used a token, held only as
 * long as the token is, and sent only to the handoff's own paths.
 */
const BROWSER_COOKIE = "lv_store_browser";
/** Long enough to sign in with Google or Apple, short enough not to linger. */
const PENDING_TTL_SECONDS = 10 * 60;

/** An HMAC-SHA256, base64url, as the pending cookie and the store's signed links (src/bigcommerce/storeMember.tsx) use. */
export async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const toBase64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

interface PendingLink {
  customerId: number;
  /** The store account's email, when the store gave one; for display only. */
  email: string | null;
  /** Set when a spent token made it; see `PENDING_COOKIE`. */
  spentTokenHash: string | null;
}

async function setPendingLink(
  c: HandoffContext,
  customerId: number,
  email: string | null,
  spentTokenHash: string | null = null,
): Promise<void> {
  const expires = Date.now() + PENDING_TTL_SECONDS * 1000;
  const body = `${customerId}.${expires}.${toBase64Url(email ?? "")}.${spentTokenHash ?? ""}`;
  const signature = await hmac(envOf(c).SESSION_SIGNING_KEY, `store-link:${body}`);
  setCookie(c, PENDING_COOKIE, `${body}.${signature}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: PENDING_TTL_SECONDS,
  });
}

/**
 * The store customer waiting to be connected, if the cookie is genuine and in
 * date. One a spent token made is left out unless `allowSpent`, which only
 * the continue step passes, because only it checks the browser's marker.
 */
async function readPendingLink(c: HandoffContext, { allowSpent = false } = {}): Promise<PendingLink | null> {
  const value = getCookie(c, PENDING_COOKIE);
  const match = value ? /^(\d+)\.(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]*)\.([A-Za-z0-9_-]+)$/.exec(value) : null;
  if (!match) return null;
  const [, customerId, expires, email, spent, signature] = match;
  if (Number(expires) < Date.now()) return null;
  const expected = await hmac(envOf(c).SESSION_SIGNING_KEY, `store-link:${customerId}.${expires}.${email}.${spent}`);
  // Both are fixed-length base64url strings of an HMAC; compare every character.
  let difference = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  if (difference !== 0) return null;
  if (spent && !allowSpent) return null;
  return { customerId: Number(customerId), email: fromBase64Url(email) || null, spentTokenHash: spent || null };
}

/** A fresh random marker for the browser spending a token. */
function newBrowserMarker(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setBrowserMarker(c: HandoffContext, marker: string, expiresAtSeconds: number): void {
  setCookie(c, BROWSER_COOKIE, marker, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: STORE_HANDOFF_PATH,
    maxAge: Math.max(60, expiresAtSeconds - Math.floor(Date.now() / 1000)),
  });
}

/** The email of the store account waiting on a sign-in, for the sign-in page to show. */
export async function pendingStoreEmail(c: HandoffContext): Promise<string | null> {
  return (await readPendingLink(c))?.email ?? null;
}

function clearPendingLink(c: HandoffContext): void {
  deleteCookie(c, PENDING_COOKIE, { httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
}

/**
 * Called by `/login/complete` once a sign-in has become a session: connects
 * the store account that was waiting for it, if any.
 */
export async function finishPendingStoreLink(
  c: HandoffContext,
  userId: number,
): Promise<"linked" | "taken" | "none"> {
  const pending = await readPendingLink(c);
  if (pending === null) return "none";
  return connectStoreAccount(c, userId, pending.customerId);
}

/** Connects a verified store customer to a signed-in user, clearing whatever was waiting. */
async function connectStoreAccount(c: HandoffContext, userId: number, customerId: number): Promise<"linked" | "taken"> {
  clearPendingLink(c);
  try {
    await linkStoreAccount(envOf(c), userId, customerId, userId);
  } catch (err) {
    if (!(err instanceof StoreAccountTaken)) throw err;
    recordOutcome("store.handoff", { result: "taken" });
    return "taken";
  }
  recordOutcome("store.handoff", { result: "linked" });
  return "linked";
}

/** The store's origin, or null when this environment has none configured. */
export function storefrontOrigin(env: Env): string | null {
  try {
    return env.BIGCOMMERCE_STOREFRONT_URL ? new URL(env.BIGCOMMERCE_STOREFRONT_URL).origin : null;
  } catch {
    return null;
  }
}

const TryAgain: FC<{ storeUrl: string | null }> = ({ storeUrl }) => (
  <Page title="Back to the store">
    <h1>That link has run out</h1>
    <p>
      The link from the store only works for a few minutes. Go back to the store and choose "Membership card"
      again.
    </p>
    {storeUrl && (
      <a href={storeUrl} class="action">
        Back to the store
      </a>
    )}
    <p class="muted">
      Still stuck? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
    </p>
  </Page>
);

const handoff = new Hono<AuthEnv>();

handoff.post(STORE_HANDOFF_PATH, async (c) => {
  const app = appConfig(c.env);
  const origin = storefrontOrigin(c.env);
  if (!app || !origin) return c.notFound();
  // Only the store may start this. The card site's usual same-origin check
  // would refuse the store; this is the same check, for the store's origin.
  if (c.req.header("Origin") !== origin) {
    recordOutcome("store.handoff", { result: "refused", reason: "origin" });
    return c.text("Forbidden", 403);
  }
  const form = await c.req.parseBody();
  const token = typeof form.jwt === "string" ? form.jwt.trim() : "";
  try {
    const { customerId, email, expiresAt } = await verifyCurrentCustomer(token, app);
    const marker = newBrowserMarker();
    const { claimed, tokenHash } = await claimHandoffToken(c.env, token, expiresAt, marker);
    if (claimed) {
      setBrowserMarker(c, marker, expiresAt);
      await setPendingLink(c, customerId, email);
    } else {
      // Spent already, most likely by this same member a few minutes ago.
      // The continue step decides, once it can see this browser's marker.
      await setPendingLink(c, customerId, email, tokenHash);
    }
  } catch (err) {
    if (!(err instanceof AppJwtRejected)) throw err;
    recordOutcome("store.handoff", { result: "refused", reason: err.reason });
    return c.html(<TryAgain storeUrl={c.env.BIGCOMMERCE_STOREFRONT_URL ?? null} />, 400);
  }
  return c.redirect(STORE_HANDOFF_CONTINUE_PATH, 303);
});

handoff.get(STORE_HANDOFF_CONTINUE_PATH, async (c) => {
  const pending = await readPendingLink(c, { allowSpent: true });
  if (pending === null) return c.redirect("/");
  const { customerId } = pending;
  const token = readSessionCookie(c);
  const session = token ? await verifySessionToken(c.env.SESSION_SIGNING_KEY, token) : null;

  if (pending.spentTokenHash) {
    const marker = getCookie(c, BROWSER_COOKIE);
    if (!marker || !(await handoffTokenHeldBy(c.env, pending.spentTokenHash, marker))) {
      // A copy of somebody's token, or this browser's marker is gone: it
      // grants nothing. Somebody signed out is told why the store didn't
      // sign them in, rather than shown a bare sign-in page.
      clearPendingLink(c);
      recordOutcome("store.handoff", { result: "refused", reason: "replayed" });
      return c.redirect(session ? "/" : `${LOGIN_PATH}?store=spent`);
    }
    recordOutcome("store.handoff", { result: "reused", reason: "same_browser" });
  }

  // Connected already: sign in as whoever it is connected to.
  const holder = await userForStoreCustomer(c.env, customerId);
  if (holder) {
    clearPendingLink(c);
    if (await isUserExpelled(c.env, holder.id)) {
      recordOutcome("store.handoff", { result: "refused", reason: EXPELLED_REASON });
      return c.redirect(`${LOGIN_PATH}?error=${EXPELLED_REASON}`);
    }
    setSessionCookie(c, await issueSessionToken(c.env.SESSION_SIGNING_KEY, { userId: holder.id, isAdmin: holder.is_admin === 1 }));
    recordOutcome("store.handoff", { result: "signed_in" });
    return c.redirect("/");
  }

  // Not connected, and signed in here: connect it to them.
  if (session && !(await isUserExpelled(c.env, session.userId))) {
    const result = await connectStoreAccount(c, session.userId, customerId);
    return c.redirect(result === "linked" ? "/?store=connected" : "/?store=taken");
  }

  // Not connected and not signed in: sign in once, and the connection is
  // made when it completes. The pending cookie waits for it, rewritten
  // without the spent mark once this browser has proved it spent the token.
  if (pending.spentTokenHash) await setPendingLink(c, customerId, pending.email);
  recordOutcome("store.handoff", { result: "needs_sign_in" });
  return c.redirect(`${LOGIN_PATH}?connect=store`);
});

/** A member disconnecting their own store account. */
handoff.post(STORE_DISCONNECT_PATH, requireAuth, csrf(), async (c) => {
  const session = c.get("session");
  await unlinkStoreAccount(c.env, session.userId, session.userId);
  return c.redirect("/?store=disconnected", 303);
});

export default handoff;
