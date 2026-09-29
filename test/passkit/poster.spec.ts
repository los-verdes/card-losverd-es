import { describe, expect, it } from "vitest";
import { POSTER_IMAGE_NAMES, POSTER_PROBE_PREFIX, applePosterMode, posterAssets } from "../../src/passkit/poster";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";

// Inlined at transform time; node:fs is not available in this pool.
const wranglerToml = Object.values(
  import.meta.glob("../../wrangler.toml", { query: "?raw", import: "default", eager: true }),
)[0] as string;
const COMMITTED = new Set(
  Object.keys(import.meta.glob("../../assets/templates/**/*.png")).map((path) => path.replace("../../assets/", "")),
);

const POSTER_THEME: CardTheme = {
  ...CLASSIC_THEME,
  id: "2026",
  artwork: { applePosterPrefix: "templates/themes/2026/apple-poster/" },
};

/** A reader that answers with each key's own name, so the test can see what was read for what. */
const read = async (key: string) => new TextEncoder().encode(key);
const decode = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]));

describe("applePosterMode", () => {
  it.each([
    ["on", "on"],
    [" Probe ", "probe"],
    ["off", "off"],
    ["true", "off"],
    [undefined, "off"],
  ] as const)("reads APPLE_POSTER_PASSES %j as %s", (value, mode) => {
    expect(applePosterMode({ APPLE_POSTER_PASSES: value })).toBe(mode);
  });

  it("is off in production and probing in staging", () => {
    expect(wranglerToml.match(/^APPLE_POSTER_PASSES = "(\w+)"$/gm)).toEqual([
      'APPLE_POSTER_PASSES = "off"',
      'APPLE_POSTER_PASSES = "probe"',
    ]);
  });
});

describe("posterAssets", () => {
  it("adds nothing when off, or when on for a theme with no poster art", async () => {
    expect(await posterAssets("off", POSTER_THEME, read)).toBeNull();
    expect(await posterAssets("on", CLASSIC_THEME, read)).toBeNull();
  });

  it("puts the theme's poster art under every name the layout might draw, with the logo as its primary logo", async () => {
    const files = decode((await posterAssets("on", POSTER_THEME, read))!);

    expect(files).toEqual({
      "primaryLogo.png": "templates/apple/logo.png",
      "primaryLogo@2x.png": "templates/apple/logo@2x.png",
      "background.png": "templates/themes/2026/apple-poster/poster.png",
      "background@2x.png": "templates/themes/2026/apple-poster/poster@2x.png",
      "background@3x.png": "templates/themes/2026/apple-poster/poster@3x.png",
      "artwork.png": "templates/themes/2026/apple-poster/poster.png",
      "artwork@2x.png": "templates/themes/2026/apple-poster/poster@2x.png",
      "artwork@3x.png": "templates/themes/2026/apple-poster/poster@3x.png",
    });
  });

  it("probes with a different labelled image under each name, whatever the theme", async () => {
    const files = decode((await posterAssets("probe", CLASSIC_THEME, read))!);

    expect(files["background@3x.png"]).toBe(`${POSTER_PROBE_PREFIX}background@3x.png`);
    expect(files["artwork@3x.png"]).toBe(`${POSTER_PROBE_PREFIX}artwork@3x.png`);
  });

  it("probes only with images that are committed for upload to R2", () => {
    for (const name of POSTER_IMAGE_NAMES) {
      for (const suffix of ["", "@2x", "@3x"]) {
        expect(COMMITTED).toContain(`${POSTER_PROBE_PREFIX}${name}${suffix}.png`);
      }
    }
  });
});
