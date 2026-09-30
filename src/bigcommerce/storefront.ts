/**
 * The script the store runs on every page (#38), served per environment at
 * `/store/storefront.js` and added to the store once, by hand, in Script
 * Manager. Its contents live here, so changing it is a deploy of this site,
 * never an edit in the store's control panel.
 *
 * It adds "Membership card" in three places, using the theme's own classes
 * (the store's theme is Cornerstone-based) so it looks like the rest of the
 * store:
 *
 * - the header, next to Sign in / Account, and the same in the mobile menu;
 * - the account pages' navigation, beside Orders and Addresses;
 * - the membership category page, under its heading.
 *
 * Choosing it asks the store who is signed in (`current.jwt`) and submits
 * that to the card site's `/store-handoff` (src/bigcommerce/storeHandoff.tsx).
 * Anyone the store doesn't know -- signed out, or who checked out as a guest
 * and has no store account -- goes to the card site's own sign-in instead.
 *
 * `/account.php?lv_connect=1`, where the card page's "Connect" button points,
 * starts the handoff on its own.
 *
 * Wherever the markup it expects is missing, it adds nothing: a theme change
 * can hide the links, but not break a page.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { appConfig } from "./appJwt";
import { STORE_HANDOFF_PATH } from "./storeHandoff";

export const STOREFRONT_SCRIPT_PATH = "/store/storefront.js";

export interface StorefrontConfig {
  /** The app whose `current.jwt` the store should issue. */
  clientId: string;
  /** Where the token is submitted. */
  handoffUrl: string;
  /** The card site itself, for anyone the store can't vouch for. */
  cardUrl: string;
}

/** The minimum of `window` the script touches, so tests can hand it a stand-in. */
export interface StorefrontWindow {
  location: { pathname: string; search: string; assign(url: string): void };
  fetch(url: string, init?: RequestInit): Promise<{ ok: boolean; text(): Promise<string> }>;
}

/**
 * The script itself. It is served as its own source text (`toString()`), so
 * it must not refer to anything outside its own body: no imports, no
 * module-level helpers, and nothing the bundler would add a helper for.
 */
export function storefrontMain(config: StorefrontConfig, win: StorefrontWindow, doc: Document): void {
  const root = doc.documentElement;
  if (root.hasAttribute("data-lv-card")) return;
  root.setAttribute("data-lv-card", "");

  const label = "Membership card";
  const tokenUrl = "/customer/current.jwt?app_client_id=" + encodeURIComponent(config.clientId);

  async function openCard(): Promise<void> {
    let token = "";
    try {
      const res = await win.fetch(tokenUrl, { credentials: "same-origin" });
      if (res.ok) token = (await res.text()).trim();
    } catch {
      token = "";
    }
    if (!token) {
      win.location.assign(config.cardUrl);
      return;
    }
    const form = doc.createElement("form");
    form.method = "POST";
    form.action = config.handoffUrl;
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = "jwt";
    input.value = token;
    form.appendChild(input);
    doc.body.appendChild(form);
    form.submit();
  }

  function cardLink(className: string, text: string): HTMLAnchorElement {
    const link = doc.createElement("a");
    link.className = className;
    link.href = config.cardUrl;
    link.textContent = text;
    link.addEventListener("click", function (event) {
      event.preventDefault();
      void openCard();
    });
    return link;
  }

  function listItem(className: string, link: HTMLAnchorElement): HTMLLIElement {
    const item = doc.createElement("li");
    item.className = className;
    item.appendChild(link);
    return item;
  }

  // The header, before Sign in / Account.
  const account = doc.querySelector(".navUser-section .navUser-item--account");
  if (account && account.parentNode) {
    account.parentNode.insertBefore(listItem("navUser-item", cardLink("navUser-action", label)), account);
  }

  // The mobile menu's account links.
  const mobile = doc.querySelector(".navPages-list--user");
  if (mobile) mobile.insertBefore(listItem("navPages-item", cardLink("navPages-action", label)), mobile.firstChild);

  // The account pages' navigation.
  const accountNav = doc.querySelector(".navBar--account .navBar-section");
  if (accountNav) accountNav.appendChild(listItem("navBar-item", cardLink("navBar-action", label)));

  // The membership category page, under its heading.
  if (/^\/membership\/?$/.test(win.location.pathname)) {
    const heading = doc.querySelector(".page-heading");
    if (heading && heading.parentNode) {
      const line = doc.createElement("p");
      line.appendChild(doc.createTextNode("Already a member? "));
      line.appendChild(cardLink("", "Open your membership card"));
      heading.parentNode.insertBefore(line, heading.nextSibling);
    }
  }

  // Sent here by the card page's "Connect" button: carry straight on. Only on
  // the account pages, which the store shows only to somebody signed in.
  if (accountNav && /[?&]lv_connect=1(&|$)/.test(win.location.search)) void openCard();
}

/**
 * The served script: `storefrontMain` with this environment's settings.
 * The bundler may wrap named functions in a `__name` helper, which the store
 * doesn't have, so a no-op one is defined alongside.
 */
export function storefrontScript(config: StorefrontConfig): string {
  return [
    "/* Los Verdes membership card: see https://github.com/los-verdes/card-losverd-es/issues/38 */",
    "(function () {",
    "  var __name = function (target) { return target; };",
    `  (${storefrontMain.toString()})(${JSON.stringify(config)}, window, document);`,
    "})();",
    "",
  ].join("\n");
}

const storefront = new Hono<{ Bindings: Env }>();

storefront.get(STOREFRONT_SCRIPT_PATH, (c) => {
  const app = appConfig(c.env);
  const headers = {
    "Content-Type": "text/javascript; charset=utf-8",
    // Short, so a change reaches the store within minutes of a deploy.
    "Cache-Control": "public, max-age=300",
  };
  // Off until this environment has an app: a script that does nothing, so
  // the store's tag never errors.
  if (!app) return c.body("/* Los Verdes membership card: not configured here. */\n", 200, headers);
  const base = c.env.PUBLIC_BASE_URL;
  return c.body(
    storefrontScript({
      clientId: app.clientId,
      handoffUrl: new URL(STORE_HANDOFF_PATH, base).toString(),
      cardUrl: new URL("/", base).toString(),
    }),
    200,
    headers,
  );
});

export default storefront;
