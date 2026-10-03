/**
 * The way back to the store, for a member who came from it.
 *
 * "Membership card" on the store signs a member in here through the store
 * handoff (src/bigcommerce/storeHandoff.tsx), and they may well have shopping
 * to finish. The handoff marks the browser with a cookie that lasts until the
 * browser closes, and every member page shows a banner back to the store while
 * it is there. Signing out clears it.
 *
 * Read through the request context, like the environment banner, because the
 * page shell is rendered from places that have no `env` or request.
 */

import type { Context } from "hono";
import { tryGetContext } from "hono/context-storage";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";
import type { Env } from "../index";

// The membership store the legacy no-membership page links to.
export const MEMBERSHIP_STORE_URL =
  "https://store.losverdesatx.org/membership/";

/**
 * The store's home page, for the way back to it: this environment's own
 * storefront (the sandbox, on staging), or the store.
 */
export function storeHomeUrl(env: Env): string {
  try {
    if (env.BIGCOMMERCE_STOREFRONT_URL) return new URL("/", env.BIGCOMMERCE_STOREFRONT_URL).toString();
  } catch {
    // A malformed setting falls back to the store below.
  }
  return new URL("/", MEMBERSHIP_STORE_URL).toString();
}

export const FROM_STORE_COOKIE = "lv_from_store";

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

/** Marks this browser as having come from the store, until it closes (no `maxAge`). */
export function markArrivedFromStore(c: Context): void {
  setCookie(c, FROM_STORE_COOKIE, "1", COOKIE_OPTIONS);
}

export function clearArrivedFromStore(c: Context): void {
  deleteCookie(c, FROM_STORE_COOKIE, COOKIE_OPTIONS);
}

export function arrivedFromStore(c: Context): boolean {
  return getCookie(c, FROM_STORE_COOKIE) === "1";
}

export const STORE_BANNER_TEXT = "Back to the Los Verdes store";

/** A strip across the top of every member page, for a member who came from the store. */
export const StoreBanner: FC = () => {
  const c = tryGetContext<{ Bindings: Env }>();
  if (!c || !arrivedFromStore(c as unknown as Context)) return null;
  return (
    <div class="store-banner" role="note">
      <a href={storeHomeUrl(c.env)}>&larr; {STORE_BANNER_TEXT}</a>
    </div>
  );
};
