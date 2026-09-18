import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
