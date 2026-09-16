import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  getCachedPass,
  invalidateCachedPass,
  putCachedPass,
} from "../../src/passkit/generator";

describe("buildManifest", () => {
  it("hashes every file with SHA-1, hex-encoded", async () => {
    const files = {
      "pass.json": new TextEncoder().encode('{"hello":"world"}'),
      "icon.png": new Uint8Array([1, 2, 3, 4]),
    };

    const manifestBytes = await buildManifest(files);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

    expect(Object.keys(manifest).sort()).toEqual(["icon.png", "pass.json"]);
    for (const hash of Object.values(manifest)) {
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("produces a different hash when file content changes", async () => {
    const a = await buildManifest({ "pass.json": new TextEncoder().encode("a") });
    const b = await buildManifest({ "pass.json": new TextEncoder().encode("b") });
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });
});

describe("pass cache (R2)", () => {
  afterEach(async () => {
    await invalidateCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023");
  });

  it("returns null on a cache miss", async () => {
    const cached = await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-NOPE");
    expect(cached).toBeNull();
  });

  it("round-trips bytes written via putCachedPass", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]); // PK.. zip magic, arbitrary test payload
    await putCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", bytes);

    const cached = await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023");

    expect(cached).not.toBeNull();
    expect(Array.from(cached!)).toEqual(Array.from(bytes));
  });

  it("invalidateCachedPass removes a cached entry", async () => {
    await putCachedPass(
      env.ASSETS,
      "pass.es.losverd.membership",
      "LV-10023",
      new Uint8Array([1]),
    );

    await invalidateCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023");

    expect(
      await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023"),
    ).toBeNull();
  });
});
