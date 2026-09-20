import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CSS, STYLESHEET_PATH, VERDE, stylesheetPathFor } from "../src/styles";
import { PUBLIC_ASSETS } from "../src/assets";
import { googleWalletConfig } from "../src/google/jwt";
import worker from "../src/index";

const CREST_KEY = "templates/card/crest.png";
// A one-pixel PNG is enough: the route streams bytes through untouched.
const CREST_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(async () => {
  await env.ASSETS.put(CREST_KEY, CREST_BYTES);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.ASSETS.delete(CREST_KEY);
});

function get(path: string, headers: HeadersInit = {}) {
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

describe("GET /assets/:name", () => {
  it("serves an allow-listed image without a session, since Google fetches it", async () => {
    const res = await get("/assets/crest.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CREST_BYTES);
  });

  it("is cacheable and revalidates with an ETag", async () => {
    const res = await get("/assets/crest.png");
    const etag = res.headers.get("ETag");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(etag).toBeTruthy();

    const revalidated = await get("/assets/crest.png", { "If-None-Match": etag! });

    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("serves nothing that isn't allow-listed, whatever else is in the bucket", async () => {
    // The Apple pass templates live in the same bucket and must stay private.
    await env.ASSETS.put("templates/apple/icon.png", CREST_BYTES);
    try {
      expect((await get("/assets/icon.png")).status).toBe(404);
      expect((await get("/assets/templates/apple/icon.png")).status).toBe(404);
      expect((await get("/assets/..%2Ftemplates%2Fapple%2Ficon.png")).status).toBe(404);
    } finally {
      await env.ASSETS.delete("templates/apple/icon.png");
    }
  });

  it("404s, and says so in the log, when a listed asset is missing from R2", async () => {
    await env.ASSETS.delete(CREST_KEY);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await get("/assets/crest.png");

    expect(res.status).toBe(404);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(CREST_KEY));
  });

  it("lists only the crest, which is what the Wallet logo points at", () => {
    expect(PUBLIC_ASSETS).toEqual({ "crest.png": CREST_KEY });
  });

  it("actually serves the URL the Google Wallet object tells Google to fetch", async () => {
    // These are assembled in different modules, and when they drifted apart
    // Google reported only "URL cannot be empty" (2026-09-18). Following the
    // real URL is the check that would have caught it.
    const { logoUri } = googleWalletConfig({
      issuerId: "3388000000022222222",
      classSuffix: "los_verdes_member_v1",
      baseUrl: "https://card.losverd.es",
    });

    expect(logoUri).not.toBe("");
    const res = await get(new URL(logoUri).pathname);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("the bundled stylesheet and font", () => {
  it("serves the stylesheet without a session, as every page links it", async () => {
    const res = await get("/assets/app.css");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain(VERDE);
    expect(css).toContain("@font-face");
  });

  it("points the font-face at the font this Worker actually serves", async () => {
    // A stylesheet naming a URL nobody serves fails silently: headings just
    // render in the fallback face and nothing says why.
    const css = await (await get("/assets/app.css")).text();
    const [, url] = css.match(/src: url\("([^"]+)"\)/) ?? [];

    expect(url).toBeDefined();
    expect((await get(url as string)).status).toBe(200);
  });

  it("serves the font as a font, cached hard, since its bytes never change", async () => {
    const res = await get("/assets/bungee.woff");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("font/woff");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("doesn't cache the stylesheet as hard, since it changes with deploys", async () => {
    const cacheControl = (await get("/assets/app.css")).headers.get("Cache-Control");

    expect(cacheControl).toContain("max-age=3600");
    expect(cacheControl).not.toContain("immutable");
  });

  it("serves the stylesheet at a path named after its contents, cached forever", async () => {
    const res = await get(STYLESHEET_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    // Safe to cache forever precisely because the name changes with the
    // bytes: a browser either has this exact file or fetches it.
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe(APP_CSS);
  });

  it("links from the pages the same path it serves", async () => {
    // The whole point. If these two disagreed, every page would 404 its own
    // stylesheet -- loudly, which is better than the silent half-styled page
    // this replaces, but still worth pinning.
    const html = await (await get("/login")).text();

    expect(html).toContain(`href="${STYLESHEET_PATH}"`);
    expect(html).not.toContain('href="/assets/app.css"');
  });

  it("changes the path when the stylesheet changes, and not otherwise", async () => {
    // The property the whole scheme rests on. A hash that did not move with
    // the content would cache a stale stylesheet forever -- strictly worse
    // than the hour-long window it replaces.
    expect(stylesheetPathFor(APP_CSS)).toBe(STYLESHEET_PATH);
    expect(stylesheetPathFor(APP_CSS + "/* a change */")).not.toBe(STYLESHEET_PATH);
  });

  it("still answers the unversioned path, for anything that still asks", async () => {
    // A tab opened before this shipped, or a copied link. Nothing renders it
    // now, so it keeps the short cache rather than being promoted.
    const res = await get("/assets/app.css");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
  });

  it("serves a favicon that is a real SVG, cached like the stylesheet", async () => {
    const res = await get("/assets/favicon.svg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
    expect(body).toContain("viewBox");
  });

  it("draws the mark in the group's own green, not a hardcoded copy of it", async () => {
    // Shares the constant with the stylesheet and the card image, so the
    // three cannot drift into three slightly different greens.
    const body = await (await get("/assets/favicon.svg")).text();

    expect(body).toContain(VERDE);
  });

  it("sends /favicon.ico to it, rather than answering 404 on every visit", async () => {
    // Pages link the SVG, so a browser never asks. Crawlers do.
    const res = await get("/favicon.ico");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/assets/favicon.svg");
  });

  it("still 404s an unknown asset name", async () => {
    expect((await get("/assets/app.js")).status).toBe(404);
  });
});
