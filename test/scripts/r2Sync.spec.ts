import { describe, expect, it } from "vitest";
import { eachLimited, filesToUpload, listEtags, syncFiles, type LocalFile, type R2Api } from "../../scripts/lib/r2Sync";

const BASE = "https://api.example.com/client/v4";
const OBJECTS = `${BASE}/accounts/acct/r2/buckets/card-assets/objects`;

function file(key: string, md5: string): LocalFile {
  return { key, md5, contentType: "image/png", body: new TextEncoder().encode(key) };
}

/**
 * A stand-in for Cloudflare's R2 object API: lists what it holds (a page at a
 * time when `pageSize` is set), and stores what is PUT, with the MD5 given in
 * `md5Of` as its ETag. Records every request.
 */
function fakeBucket(
  initial: Record<string, string>,
  { pageSize = 1000, md5Of = (key: string) => `md5-of-${key}`, respond }: {
    pageSize?: number;
    md5Of?: (key: string) => string;
    respond?: (req: Request) => Response | undefined;
  } = {},
) {
  const objects = new Map(Object.entries(initial));
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init) as Request;
    requests.push(req.clone() as Request);
    const override = respond?.(req);
    if (override) return override;
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/objects")) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(url.searchParams.get("prefix") ?? "")).sort();
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      return Response.json({
        success: true,
        errors: [],
        result: page.map((key) => ({ key, etag: `"${objects.get(key)}"` })),
        result_info: { is_truncated: more, cursor: more ? String(start + pageSize) : undefined },
      });
    }
    if (req.method === "PUT") {
      const key = decodeURIComponent(url.pathname.slice(new URL(OBJECTS).pathname.length + 1));
      objects.set(key, md5Of(key));
      return Response.json({ success: true, result: { key } });
    }
    return new Response("unexpected", { status: 500 });
  };
  const api: R2Api = { base: BASE, token: "tok", accountId: "acct", bucket: "card-assets", fetch: fetch as typeof globalThis.fetch, retryDelayMs: 1 };
  return { api, objects, requests };
}

describe("filesToUpload", () => {
  it("keeps only what the bucket lacks or holds different contents for", () => {
    const files = [file("templates/a.png", "aaa"), file("templates/b.png", "BBB"), file("templates/c.png", "ccc")];
    const remote = new Map([
      ["templates/a.png", "aaa"],
      ["templates/b.png", "bbb"],
    ]);

    expect(filesToUpload(files, remote).map((f) => f.key)).toEqual(["templates/c.png"]);
  });

  it("treats a multipart ETag as different, so the object is uploaded whole", () => {
    expect(filesToUpload([file("templates/a.png", "aaa")], new Map([["templates/a.png", "aaa-2"]]))).toHaveLength(1);
  });
});

describe("listEtags", () => {
  it("follows the cursor through every page, unquoting ETags, with the token", async () => {
    const { api, requests } = fakeBucket({ "templates/a.png": "AAA", "templates/b.png": "bbb", "templates/c.png": "ccc", "cache/x": "x" }, { pageSize: 2 });

    const etags = await listEtags(api, "templates/");

    expect(Object.fromEntries(etags)).toEqual({ "templates/a.png": "aaa", "templates/b.png": "bbb", "templates/c.png": "ccc" });
    expect(requests).toHaveLength(2);
    expect(requests.every((req) => req.headers.get("Authorization") === "Bearer tok")).toBe(true);
    expect(new URL(requests[0].url).searchParams.get("prefix")).toBe("templates/");
  });

  it("fails loudly when the API refuses", async () => {
    const { api } = fakeBucket({}, { respond: () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }) });

    await expect(listEtags(api, "templates/")).rejects.toThrow(/listing card-assets\/templates\/ failed \(403\).*Authentication error/);
  });

  it("tries again after a rate limit or a server error", async () => {
    let refusals = 2;
    const { api, requests } = fakeBucket({ "templates/a.png": "aaa" }, {
      respond: () => (refusals-- > 0 ? new Response("slow down", { status: refusals === 1 ? 429 : 503 }) : undefined),
    });

    expect((await listEtags(api, "templates/")).size).toBe(1);
    expect(requests).toHaveLength(3);
  });
});

describe("syncFiles", () => {
  it("uploads only what changed, under an encoded path with its content type, and leaves other objects alone", async () => {
    const { api, objects, requests } = fakeBucket({
      "templates/same.png": "md5-of-templates/same.png",
      "templates/old.png": "stale",
      "templates/gone.png": "kept",
    });
    const files = [file("templates/same.png", "md5-of-templates/same.png"), file("templates/old.png", "md5-of-templates/old.png"), file("templates/apple/icon@2x.png", "md5-of-templates/apple/icon@2x.png")];

    const result = await syncFiles(api, "templates/", files);

    expect(result).toEqual({ uploaded: ["templates/old.png", "templates/apple/icon@2x.png"], unchanged: 1 });
    const puts = requests.filter((req) => req.method === "PUT");
    expect(puts.map((req) => new URL(req.url).pathname)).toEqual(
      expect.arrayContaining(["/client/v4/accounts/acct/r2/buckets/card-assets/objects/templates/apple/icon%402x.png"]),
    );
    expect(puts.every((req) => req.headers.get("Content-Type") === "image/png")).toBe(true);
    expect(objects.get("templates/gone.png")).toBe("kept");
  });

  it("makes no uploads, and lists once, when nothing changed", async () => {
    const { api, requests } = fakeBucket({ "templates/a.png": "md5-of-templates/a.png" });

    expect(await syncFiles(api, "templates/", [file("templates/a.png", "md5-of-templates/a.png")])).toEqual({ uploaded: [], unchanged: 1 });
    expect(requests.map((req) => req.method)).toEqual(["GET"]);
  });

  it("only reports what it would upload on a dry run", async () => {
    const { api, requests } = fakeBucket({});

    expect(await syncFiles(api, "templates/", [file("templates/a.png", "x")], { dryRun: true })).toEqual({ uploaded: ["templates/a.png"], unchanged: 0 });
    expect(requests.every((req) => req.method === "GET")).toBe(true);
  });

  it("fails when an upload is refused", async () => {
    const { api } = fakeBucket({}, { respond: (req) => (req.method === "PUT" ? new Response("forbidden", { status: 403 }) : undefined) });

    await expect(syncFiles(api, "templates/", [file("templates/a.png", "x")])).rejects.toThrow(/uploading card-assets\/templates\/a.png failed \(403\): forbidden/);
  });

  it("fails when the bucket still differs after uploading", async () => {
    const { api } = fakeBucket({}, { md5Of: () => "garbled" });

    await expect(syncFiles(api, "templates/", [file("templates/a.png", "md5-of-templates/a.png")])).rejects.toThrow(/still differs for: templates\/a.png/);
  });
});

describe("eachLimited", () => {
  it("runs every item, never more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];

    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(n);
      running--;
    });

    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });

  it("does nothing for nothing", async () => {
    await expect(eachLimited([], 8, async () => {})).resolves.toBeUndefined();
  });
});
