/**
 * The script the store runs on every page (#38), served per environment at
 * `/store/storefront.js` and added to the store once, by hand, in Script
 * Manager. Its contents live here, so changing it is a deploy of this site,
 * never an edit in the store's control panel.
 *
 * It adds "Membership card" in two places, using the theme's own classes
 * (the store's theme is Cornerstone-based) so it looks like the rest of the
 * store:
 *
 * - the header, next to Account, and the same in the mobile menu, once the
 *   store says somebody is signed in to it: a signed-out visitor or a guest
 *   has no store account for it to bring in, so it would only lead them to
 *   another sign-in;
 * - the account pages' navigation, beside Orders and Addresses, which only
 *   somebody signed in sees anyway.
 *
 * Choosing it asks the store who is signed in (`current.jwt`) and submits
 * that to the card site's `/store-handoff` (src/bigcommerce/storeHandoff.tsx).
 * Anyone the store doesn't know -- signed out, or who checked out as a guest
 * and has no store account -- goes to the card site's own sign-in instead.
 *
 * The card page's "Connect" button points at `/account.php#lv-connect`. The
 * store drops query strings on the way to its account page (and to its
 * sign-in page, for somebody signed out), but a browser keeps the fragment
 * across those redirects. Seeing it, the script remembers the request in the
 * store's session storage for ten minutes, and starts the handoff on whichever
 * page first finds the customer signed in: at once if they already were, or
 * after they sign in to the store.
 *
 * On the account pages it also shows the member's card itself: it
 * asks `/store/member` with the store's token, and draws the card with its
 * wallet buttons, or says the membership ran out, or offers to connect the
 * store account. Changing the name or theme, or emailing the card, links
 * through to the card site. The membership category page is left as the
 * store has it.
 *
 * Wherever the markup it expects is missing, it adds nothing: a theme change
 * can hide the links, but not break a page.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { appConfig } from "./appJwt";
import { STORE_HANDOFF_PATH } from "./storeHandoff";
import { STORE_MEMBER_PATH, type StoreMemberResponse } from "./storeMember";

export const STOREFRONT_SCRIPT_PATH = "/store/storefront.js";

export interface StorefrontConfig {
  /** The app whose `current.jwt` the store should issue. */
  clientId: string;
  /** Where the token is submitted. */
  handoffUrl: string;
  /** The card site itself, for anyone the store can't vouch for. */
  cardUrl: string;
  /** Where the card on the store comes from (src/bigcommerce/storeMember.tsx). */
  memberUrl: string;
}

/** The minimum of `window` the script touches, so tests can hand it a stand-in. */
export interface StorefrontWindow {
  location: { pathname: string; search: string; hash: string; assign(url: string): void };
  fetch(url: string, init?: RequestInit): Promise<{ ok: boolean; text(): Promise<string>; json(): Promise<unknown> }>;
  /** Absent or throwing in some browsers' private modes; the script copes. */
  sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
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
  const connectKey = "lv-card-connect";
  const connectForMs = 10 * 60 * 1000;

  /** The store's token for whoever is signed in to it, or "" for nobody. */
  async function storeToken(): Promise<string> {
    try {
      const res = await win.fetch(tokenUrl, { credentials: "same-origin" });
      return res.ok ? (await res.text()).trim() : "";
    } catch {
      return "";
    }
  }

  // Who is signed in to the store, asked once for this page: the header
  // links, a Connect carrying on, and the card on the account pages all wait
  // on it. Choosing the link asks again, as time may have passed.
  const signedIn = storeToken();

  function submit(token: string): void {
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

  async function openCard(): Promise<void> {
    const token = await storeToken();
    if (token) submit(token);
    else win.location.assign(config.cardUrl);
  }

  // The card page's "Connect", remembered across the store's own pages.
  function rememberConnect(): void {
    try {
      if (win.sessionStorage) win.sessionStorage.setItem(connectKey, String(Date.now()));
    } catch {
      // Nowhere to remember it: this page is the only chance.
    }
  }
  function connectRemembered(): boolean {
    try {
      const at = Number(win.sessionStorage ? win.sessionStorage.getItem(connectKey) : 0);
      return at > 0 && Date.now() - at < connectForMs;
    } catch {
      return false;
    }
  }
  function forgetConnect(): void {
    try {
      if (win.sessionStorage) win.sessionStorage.removeItem(connectKey);
    } catch {
      // Nothing was remembered.
    }
  }
  /** Hands off once the store knows who this is; until then, waits for them to sign in to it. */
  async function connect(): Promise<void> {
    const token = await signedIn;
    if (!token) return;
    forgetConnect();
    submit(token);
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

  // The header, before Account, and the mobile menu's account links: only
  // for somebody signed in to the store.
  void signedIn.then(function (token) {
    if (!token) return;
    const account = doc.querySelector(".navUser-section .navUser-item--account");
    if (account && account.parentNode) {
      account.parentNode.insertBefore(listItem("navUser-item", cardLink("navUser-action", label)), account);
    }
    const mobile = doc.querySelector(".navPages-list--user");
    if (mobile) mobile.insertBefore(listItem("navPages-item", cardLink("navPages-action", label)), mobile.firstChild);
  });

  // The account pages' navigation.
  const accountNav = doc.querySelector(".navBar--account .navBar-section");
  if (accountNav) accountNav.appendChild(listItem("navBar-item", cardLink("navBar-action", label)));

  // Sent by the card page's "Connect" button (`?lv_connect=1` is the link it
  // gave before the fragment, still honoured).
  const asked = /^#lv-connect$/.test(win.location.hash) || /[?&]lv_connect=1(&|$)/.test(win.location.search);
  if (asked) rememberConnect();
  const connecting = asked || connectRemembered();
  if (connecting) {
    void connect();
    return;
  }

  // The card itself, on the account pages.
  function element(tag: string, attributes: Record<string, string>, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    for (const name of Object.keys(attributes)) node.setAttribute(name, attributes[name]);
    if (text) node.appendChild(doc.createTextNode(text));
    return node;
  }
  function showDate(iso: string): string {
    const date = new Date(iso + "T00:00:00Z");
    return isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  async function showCard(after: Element): Promise<void> {
    const token = await signedIn;
    if (!token) return;
    let data: StoreMemberResponse;
    try {
      const res = await win.fetch(config.memberUrl, { headers: { Authorization: "Bearer " + token }, credentials: "omit" });
      if (!res.ok) return;
      data = (await res.json()) as StoreMemberResponse;
    } catch {
      return;
    }
    // Centred, and no wider than the card: a card hugging the left edge of the
    // page looked lost.
    const panel = element("section", {
      class: "lv-card-panel",
      style: "margin: 1.5rem auto; max-width: 420px; text-align: center",
    });
    panel.appendChild(element("h3", {}, "Your membership card"));
    if (!data.connected || !data.member) {
      const line = element(
        "p",
        {},
        data.connected
          ? "Your store account is connected, but there's no Los Verdes membership on it yet. "
          : "Connect your store account to see your Los Verdes membership card here. ",
      );
      line.appendChild(cardLink("", data.connected ? "Open the card site" : "Connect it"));
      panel.appendChild(line);
    } else if (!data.member.current) {
      const line = element(
        "p",
        {},
        data.member.goodThrough ? "Your membership ran out on " + showDate(data.member.goodThrough) + ". " : "Your membership isn't current. ",
      );
      line.appendChild(element("a", { href: "/membership/" }, "Renew it"));
      panel.appendChild(line);
    } else {
      const member = data.member;
      if (member.cardImageUrl) {
        panel.appendChild(
          element("img", {
            src: member.cardImageUrl,
            alt: "Los Verdes membership card for " + member.name,
            style: "display: block; width: 100%; max-width: 360px; height: auto; margin: 0 auto; border-radius: 12px",
          }),
        );
      }
      if (member.goodThrough) panel.appendChild(element("p", {}, "Good through " + showDate(member.goodThrough)));
      const wallets = element("p", {});
      if (member.appleWalletUrl) wallets.appendChild(element("a", { class: "button button--primary", href: member.appleWalletUrl }, "Add to Apple Wallet"));
      if (member.appleWalletUrl && member.googleWalletUrl) wallets.appendChild(doc.createTextNode(" "));
      if (member.googleWalletUrl) wallets.appendChild(element("a", { class: "button", href: member.googleWalletUrl }, "Save to Google Wallet"));
      panel.appendChild(wallets);
      const more = element("p", {});
      more.appendChild(cardLink("", "Change the name or theme, or email yourself the card"));
      panel.appendChild(more);
    }
    if (after.parentNode) after.parentNode.insertBefore(panel, after.nextSibling);
  }

  const accountBar = doc.querySelector(".navBar--account");
  if (accountBar) void showCard(accountBar);
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
      memberUrl: new URL(STORE_MEMBER_PATH, base).toString(),
    }),
    200,
    headers,
  );
});

export default storefront;
