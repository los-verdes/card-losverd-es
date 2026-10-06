import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontMain, storefrontScript, type StorefrontConfig, type StorefrontWindow } from "../../src/bigcommerce/storefront";
import type { StoreMemberResponse } from "../../src/bigcommerce/storeMember";
import worker from "../../src/index";
import { FakeDocument, FakeElement, el } from "../fixtures/miniDom";

const CONFIG: StorefrontConfig = {
  clientId: "app-client-id",
  handoffUrl: "https://card.example.com/store-handoff",
  cardUrl: "https://card.example.com/",
  memberUrl: "https://card.example.com/store/member",
};

/** A store page shaped like the store's Cornerstone-based theme, with whichever parts are asked for. */
function storePage({ header = true, mobile = true, accountNav = false, heading = "" } = {}) {
  const doc = new FakeDocument();
  if (header) {
    doc.body.appendChild(
      el("nav.navUser", el("ul.navUser-section.navUser-section--alt", el("li.navUser-item"), el("li.navUser-item.navUser-item--account", el("a.navUser-action", "Sign in")))),
    );
  }
  if (mobile) doc.body.appendChild(el("ul.navPages-list.navPages-list--user", el("li.navPages-item", el("a.navPages-action", "Sign in"))));
  if (accountNav) {
    doc.body.appendChild(el("nav.navBar.navBar--sub.navBar--account", el("ul.navBar-section", el("li.navBar-item", el("a.navBar-action", "Orders")))));
  }
  if (heading) doc.body.appendChild(el("div.container", el("h1.page-heading", heading), el("div.page")));
  return doc;
}

/** The store's session storage, kept across the pages of one "visit" in a test. */
function fakeStorage(): Storage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  } as unknown as Storage & { entries: Map<string, string> };
}

function storeWindow({
  pathname = "/",
  search = "",
  hash = "",
  token = "store.jwt.token" as string | null,
  fails = false,
  storage = fakeStorage() as StorefrontWindow["sessionStorage"] | undefined,
  /** What `/store/member` answers; null for an error. */
  member = null as StoreMemberResponse | null,
  memberFails = false,
} = {}) {
  const assign = vi.fn();
  // What the store answers, changeable between page load and a click.
  const store = { token, fails };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    if (store.fails) throw new TypeError("network");
    if (url === CONFIG.memberUrl) {
      if (memberFails) throw new TypeError("network");
      return { ok: member !== null, text: async () => JSON.stringify(member), json: async () => member };
    }
    return { ok: store.token !== null, text: async () => (store.token === null ? "" : `${store.token}\n`), json: async () => null };
  });
  const win: StorefrontWindow = { location: { pathname, search, hash, assign }, fetch, sessionStorage: storage };
  return { win, assign, fetch, store };
}

const formIn = (doc: FakeDocument) => doc.body.children.find((child) => child.tagName === "form");

const run = (doc: FakeDocument, win: StorefrontWindow) => storefrontMain(CONFIG, win, doc as unknown as Document);

function linkIn(doc: FakeDocument, selector: string): FakeElement | undefined {
  return doc.querySelectorAll(selector).find((a) => a.textContent.includes("embership card"));
}

/** Resolves once the click's async work has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the storefront script", () => {
  it("adds Membership card to the header before Account, and to the mobile menu first, pointing at the card site", async () => {
    const doc = storePage();
    run(doc, storeWindow().win);
    await settle();

    const header = doc.querySelector(".navUser-section")!.children;
    expect(header.map((li) => li.textContent)).toEqual(["", "Membership card", "Sign in"]);
    expect(header[1].className).toBe("navUser-item");
    expect(header[1].children[0]).toMatchObject({ className: "navUser-action", href: CONFIG.cardUrl });

    const mobile = doc.querySelector(".navPages-list--user")!.children;
    expect(mobile[0].textContent).toBe("Membership card");
    expect(mobile[0].children[0].className).toBe("navPages-action");
  });

  it.each([
    ["signed out of the store", { token: null }],
    ["the store unreachable", { fails: true }],
    ["an empty answer", { token: "  " }],
  ])("leaves the header and mobile menu alone with %s: there is no store account to bring in", async (_, options) => {
    const doc = storePage();
    run(doc, storeWindow(options).win);
    await settle();

    expect(linkIn(doc, ".navUser-action")).toBeUndefined();
    expect(linkIn(doc, ".navPages-action")).toBeUndefined();
  });

  it("adds a tab to the account pages' navigation", () => {
    const doc = storePage({ accountNav: true });
    run(doc, storeWindow({ pathname: "/account.php" }).win);

    expect(doc.querySelector(".navBar--account .navBar-section")!.children.map((li) => li.textContent)).toEqual(["Orders", "Membership card"]);
  });

  it("leaves the membership category page as the store has it", async () => {
    const membership = storePage({ heading: "Membership" });
    const { win, fetch } = storeWindow({ pathname: "/membership/", member: { connected: true, member: null } });
    run(membership, win);
    await settle();

    expect(membership.querySelector(".container")!.children.map((child) => child.tagName)).toEqual(["h1", "div"]);
    expect(fetch).not.toHaveBeenCalledWith(CONFIG.memberUrl, expect.anything());
  });

  it("adds nothing where the theme's markup is missing, and nothing twice", async () => {
    const bare = storePage({ header: false, mobile: false });
    run(bare, storeWindow({ pathname: "/membership/" }).win);
    await settle();
    expect(bare.body.children).toHaveLength(0);

    const doc = storePage();
    run(doc, storeWindow().win);
    run(doc, storeWindow().win);
    await settle();
    expect(doc.querySelector(".navUser-section")!.children).toHaveLength(3);
  });

  it("submits the store's token to the card site when somebody signed in to the store chooses it", async () => {
    const doc = storePage();
    const { win, fetch, assign } = storeWindow({ token: "header.payload.signature" });
    run(doc, win);
    await settle();

    expect(linkIn(doc, ".navUser-action")!.click()).toBe(true);
    await settle();

    expect(fetch).toHaveBeenCalledWith("/customer/current.jwt?app_client_id=app-client-id", { credentials: "same-origin" });
    const form = doc.body.children.find((child) => child.tagName === "form")!;
    expect(form).toMatchObject({ method: "POST", action: CONFIG.handoffUrl, submitted: 1 });
    expect(form.children[0]).toMatchObject({ type: "hidden", name: "jwt", value: "header.payload.signature" });
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["signed out of the store since", { token: null }],
    ["the store unreachable", { fails: true }],
    ["an empty answer", { token: "  " }],
  ])("goes to the card site's own sign-in when chosen with %s", async (_, options) => {
    const doc = storePage();
    const { win, assign, store } = storeWindow();
    run(doc, win);
    await settle();
    Object.assign(store, options);

    linkIn(doc, ".navPages-action")!.click();
    await settle();

    expect(assign).toHaveBeenCalledWith(CONFIG.cardUrl);
    expect(doc.body.children.some((child) => child.tagName === "form")).toBe(false);
  });

  it("hands off at once from the card page's Connect button when already signed in to the store, on whatever page it lands", async () => {
    for (const [pathname, hash, search] of [["/account.php", "#lv-connect", ""], ["/account.php", "", "?action=order_status&lv_connect=1"], ["/", "#lv-connect", ""]]) {
      const doc = storePage();
      const { win, fetch } = storeWindow({ pathname, hash, search, token: "a.b.c" });
      run(doc, win);
      await settle();

      expect(fetch).toHaveBeenCalledOnce();
      expect(formIn(doc)).toMatchObject({ action: CONFIG.handoffUrl, submitted: 1 });
      expect(win.sessionStorage!.getItem("lv-card-connect")).toBeNull();
    }
  });

  it("waits through a sign-in to the store, then hands off on the next page", async () => {
    const storage = fakeStorage();
    // Signed out: the store sends /account.php#lv-connect to its sign-in page, keeping the fragment.
    const signIn = storePage();
    const signedOut = storeWindow({ pathname: "/login.php", search: "?from=account.php%3Faction%3D", hash: "#lv-connect", token: null, storage });
    run(signIn, signedOut.win);
    await settle();
    expect(formIn(signIn)).toBeUndefined();
    expect(signedOut.assign).not.toHaveBeenCalled();
    expect(storage.entries.has("lv-card-connect")).toBe(true);

    // Signed in, the store lands them on their account page, fragment gone.
    const account = storePage({ accountNav: true });
    run(account, storeWindow({ pathname: "/account.php", token: "a.b.c", storage }).win);
    await settle();
    expect(formIn(account)).toMatchObject({ submitted: 1 });
    expect(storage.entries.has("lv-card-connect")).toBe(false);

    // And only once.
    const later = storePage();
    const again = storeWindow({ pathname: "/", token: "a.b.c", storage });
    run(later, again.win);
    await settle();
    expect(formIn(later)).toBeUndefined();
  });

  it("forgets a Connect after ten minutes", async () => {
    const storage = fakeStorage();
    storage.setItem("lv-card-connect", String(Date.now() - 11 * 60 * 1000));
    const doc = storePage();
    run(doc, storeWindow({ storage }).win);
    await settle();
    expect(formIn(doc)).toBeUndefined();
  });

  it("still hands off from the page Connect lands on where session storage is missing or refuses", async () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    for (const storage of [undefined, refusing]) {
      const doc = storePage();
      const { win } = storeWindow({ hash: "#lv-connect", token: "a.b.c", storage });
      run(doc, win);
      await settle();
      expect(formIn(doc)).toMatchObject({ submitted: 1 });
    }
  });

  it("ignores lookalikes", async () => {
    for (const [hash, search] of [["#lv-connected", ""], ["#other", "?lv_connect=10"]]) {
      const doc = storePage();
      run(doc, storeWindow({ hash, search }).win);
      await settle();
      expect(formIn(doc)).toBeUndefined();
    }
  });
});

describe("the card on the store", () => {
  const CURRENT: StoreMemberResponse = {
    connected: true,
    member: {
      name: "Jane Doe",
      cardNumber: "BC-1",
      goodThrough: "2027-02-14",
      memberSince: "2021-07-15",
      current: true,
      cardImageUrl: "https://card.example.com/store/card.png?m=BC-1&x=1&s=a",
      appleWalletUrl: "https://card.example.com/store/apple.pkpass?m=BC-1&x=1&s=b",
      googleWalletUrl: "https://card.example.com/store/google?m=BC-1&x=1&s=c",
    },
  };
  const LAPSED: StoreMemberResponse = { connected: true, member: { name: "Jane Doe", cardNumber: "BC-1", goodThrough: "2026-02-14", memberSince: null, current: false } };
  const panelIn = (doc: FakeDocument) => doc.querySelector(".lv-card-panel");

  it("draws the card, its wallet buttons and a way to change it, under the account navigation", async () => {
    const doc = storePage({ accountNav: true });
    const { win, fetch } = storeWindow({ pathname: "/account.php", token: "a.b.c", member: CURRENT });
    run(doc, win);
    await settle();

    expect(fetch).toHaveBeenCalledWith(CONFIG.memberUrl, { headers: { Authorization: "Bearer a.b.c" }, credentials: "omit" });
    const panel = panelIn(doc)!;
    const children = doc.body.children;
    expect(children.indexOf(panel)).toBe(children.indexOf(doc.querySelector(".navBar--account")!) + 1);
    const image = panel.children.find((child) => child.tagName === "img")!;
    expect(image.getAttribute("src")).toBe(CURRENT.member!.cardImageUrl);
    expect(image.getAttribute("alt")).toBe("Los Verdes membership card for Jane Doe");
    expect(panel.textContent).toContain("Good through Feb 14, 2027");
    const links = panel.querySelectorAll("button");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Add to Apple Wallet", CURRENT.member!.appleWalletUrl],
      ["Save to Google Wallet", CURRENT.member!.googleWalletUrl],
    ]);
    expect(panel.textContent).toContain("Change the name or theme, or email yourself the card");
    // Centred on the page, card and all.
    expect(panel.getAttribute("style")).toContain("margin: 1.5rem auto");
    expect(panel.getAttribute("style")).toContain("text-align: center");
    expect(image.getAttribute("style")).toContain("margin: 0 auto");
  });

  it("offers to connect an unconnected store account", async () => {
    const account = storePage({ accountNav: true });
    run(account, storeWindow({ pathname: "/account.php", member: { connected: false } }).win);
    await settle();
    expect(panelIn(account)!.textContent).toContain("Connect your store account to see your Los Verdes membership card here. Connect it");
  });

  it("says when a connected account has no membership yet", async () => {
    const doc = storePage({ accountNav: true });
    run(doc, storeWindow({ pathname: "/account.php", member: { connected: true, member: null } }).win);
    await settle();
    expect(panelIn(doc)!.textContent).toContain("there's no Los Verdes membership on it yet");
  });

  it("says when the membership ran out, offering to renew", async () => {
    const account = storePage({ accountNav: true });
    run(account, storeWindow({ pathname: "/account.php", member: LAPSED }).win);
    await settle();
    expect(panelIn(account)!.textContent).toContain("Your membership ran out on Feb 14, 2026. Renew it");
    expect(panelIn(account)!.querySelectorAll("img")).toEqual([]);
  });

  it("shows nothing for a guest, a failed request, or while Connect is carrying on", async () => {
    for (const options of [{ token: null }, { member: null }, { memberFails: true }]) {
      const doc = storePage({ accountNav: true });
      run(doc, storeWindow({ pathname: "/account.php", member: CURRENT, ...options }).win);
      await settle();
      expect(panelIn(doc)).toBeNull();
    }

    const doc = storePage({ accountNav: true });
    const connecting = storeWindow({ pathname: "/account.php", hash: "#lv-connect", member: CURRENT });
    run(doc, connecting.win);
    await settle();
    expect(connecting.fetch).not.toHaveBeenCalledWith(CONFIG.memberUrl, expect.anything());
  });
});

describe("storefrontScript", () => {
  it("wraps the function with its settings and a stand-in for the bundler's __name helper", () => {
    const source = storefrontScript(CONFIG);

    expect(source).toContain("var __name = function (target) { return target; };");
    expect(source).toContain(`${JSON.stringify(CONFIG)}, window, document);`);
    expect(source).toContain("function storefrontMain(");
  });
});

describe("GET /store/storefront.js", () => {
  beforeEach(() => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "app-client-id";
    env.BIGCOMMERCE_APP_CLIENT_SECRET = "app-client-secret-0123456789abcdef";
    env.PUBLIC_BASE_URL = "https://card.losverd.es";
  });
  afterEach(() => {
    env.BIGCOMMERCE_APP_CLIENT_ID = "";
    env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
  });

  const fetchScript = () => worker.fetch(new Request("https://card.losverd.es/store/storefront.js"), env, createExecutionContext());

  it("serves the script with this environment's app and addresses, cached briefly, to anyone", async () => {
    const res = await fetchScript();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const source = await res.text();
    expect(source).toContain('"clientId":"app-client-id"');
    expect(source).toContain('"handoffUrl":"https://card.losverd.es/store-handoff"');
    expect(source).toContain('"cardUrl":"https://card.losverd.es/"');
  });

  it("serves a script that does nothing until the environment has an app", async () => {
    env.BIGCOMMERCE_APP_CLIENT_SECRET = undefined;
    const res = await fetchScript();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/* Los Verdes membership card: not configured here. */\n");
  });
});
