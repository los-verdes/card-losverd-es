import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontMain, storefrontScript, type StorefrontConfig, type StorefrontWindow } from "../../src/bigcommerce/storefront";
import worker from "../../src/index";
import { FakeDocument, FakeElement, el } from "../fixtures/miniDom";

const CONFIG: StorefrontConfig = {
  clientId: "app-client-id",
  handoffUrl: "https://card.example.com/store-handoff",
  cardUrl: "https://card.example.com/",
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

function storeWindow({ pathname = "/", search = "", token = "store.jwt.token" as string | null, fails = false } = {}) {
  const assign = vi.fn();
  const fetch = vi.fn(async () => {
    if (fails) throw new TypeError("network");
    return { ok: token !== null, text: async () => (token === null ? "" : `${token}\n`) };
  });
  const win: StorefrontWindow = { location: { pathname, search, assign }, fetch };
  return { win, assign, fetch };
}

const run = (doc: FakeDocument, win: StorefrontWindow) => storefrontMain(CONFIG, win, doc as unknown as Document);

function linkIn(doc: FakeDocument, selector: string): FakeElement | undefined {
  return doc.querySelectorAll(selector).find((a) => a.textContent.includes("embership card"));
}

/** Resolves once the click's async work has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the storefront script", () => {
  it("adds Membership card to the header before Sign in, and to the mobile menu first, pointing at the card site", () => {
    const doc = storePage();
    run(doc, storeWindow().win);

    const header = doc.querySelector(".navUser-section")!.children;
    expect(header.map((li) => li.textContent)).toEqual(["", "Membership card", "Sign in"]);
    expect(header[1].className).toBe("navUser-item");
    expect(header[1].children[0]).toMatchObject({ className: "navUser-action", href: CONFIG.cardUrl });

    const mobile = doc.querySelector(".navPages-list--user")!.children;
    expect(mobile[0].textContent).toBe("Membership card");
    expect(mobile[0].children[0].className).toBe("navPages-action");
  });

  it("adds a tab to the account pages' navigation", () => {
    const doc = storePage({ accountNav: true });
    run(doc, storeWindow({ pathname: "/account.php" }).win);

    expect(doc.querySelector(".navBar--account .navBar-section")!.children.map((li) => li.textContent)).toEqual(["Orders", "Membership card"]);
  });

  it("adds a line under the membership page's heading, and only on that page", () => {
    const membership = storePage({ heading: "Membership" });
    run(membership, storeWindow({ pathname: "/membership/" }).win);
    const container = membership.querySelector(".container")!;
    expect(container.children.map((child) => child.tagName)).toEqual(["h1", "p", "div"]);
    expect(container.children[1].textContent).toBe("Already a member? Open your membership card");

    const other = storePage({ heading: "Scarves" });
    run(other, storeWindow({ pathname: "/scarves/" }).win);
    expect(other.querySelector(".container")!.children.map((child) => child.tagName)).toEqual(["h1", "div"]);
  });

  it("adds nothing where the theme's markup is missing, and nothing twice", () => {
    const bare = storePage({ header: false, mobile: false });
    run(bare, storeWindow({ pathname: "/membership/" }).win);
    expect(bare.body.children).toHaveLength(0);

    const doc = storePage();
    run(doc, storeWindow().win);
    run(doc, storeWindow().win);
    expect(doc.querySelector(".navUser-section")!.children).toHaveLength(3);
  });

  it("submits the store's token to the card site when somebody signed in to the store chooses it", async () => {
    const doc = storePage();
    const { win, fetch, assign } = storeWindow({ token: "header.payload.signature" });
    run(doc, win);

    expect(linkIn(doc, ".navUser-action")!.click()).toBe(true);
    await settle();

    expect(fetch).toHaveBeenCalledWith("/customer/current.jwt?app_client_id=app-client-id", { credentials: "same-origin" });
    const form = doc.body.children.find((child) => child.tagName === "form")!;
    expect(form).toMatchObject({ method: "POST", action: CONFIG.handoffUrl, submitted: 1 });
    expect(form.children[0]).toMatchObject({ type: "hidden", name: "jwt", value: "header.payload.signature" });
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["signed out of the store", { token: null }],
    ["the store unreachable", { fails: true }],
    ["an empty answer", { token: "  " }],
  ])("goes to the card site's own sign-in with %s", async (_, options) => {
    const doc = storePage();
    const { win, assign } = storeWindow(options);
    run(doc, win);

    linkIn(doc, ".navPages-action")!.click();
    await settle();

    expect(assign).toHaveBeenCalledWith(CONFIG.cardUrl);
    expect(doc.body.children.some((child) => child.tagName === "form")).toBe(false);
  });

  it("carries straight on from the card page's Connect button, on the account pages only", async () => {
    const account = storePage({ accountNav: true });
    const connecting = storeWindow({ pathname: "/account.php", search: "?lv_connect=1" });
    run(account, connecting.win);
    await settle();
    expect(connecting.fetch).toHaveBeenCalledOnce();

    const elsewhere = storeWindow({ pathname: "/login.php", search: "?lv_connect=1" });
    run(storePage(), elsewhere.win);
    const lookalike = storeWindow({ pathname: "/account.php", search: "?lv_connect=10" });
    run(storePage({ accountNav: true }), lookalike.win);
    await settle();
    expect(elsewhere.fetch).not.toHaveBeenCalled();
    expect(lookalike.fetch).not.toHaveBeenCalled();
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
