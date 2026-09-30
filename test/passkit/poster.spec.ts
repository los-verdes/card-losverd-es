import { describe, expect, it } from "vitest";
import { applePosterMode, posterAssets } from "../../src/passkit/poster";
import { CARD_THEMES, CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";

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
    [" On ", "on"],
    ["off", "off"],
    ["probe", "off"],
    [undefined, "off"],
  ] as const)("reads APPLE_POSTER_PASSES %j as %s", (value, mode) => {
    expect(applePosterMode({ APPLE_POSTER_PASSES: value })).toBe(mode);
  });

  it("is off in production and on in staging, where the posters are checked first", () => {
    expect(wranglerToml.match(/^APPLE_POSTER_PASSES = "(\w+)"$/gm)).toEqual([
      'APPLE_POSTER_PASSES = "off"',
      'APPLE_POSTER_PASSES = "on"',
    ]);
  });
});

describe("posterAssets", () => {
  it("adds nothing when off, or for a theme with no poster art", async () => {
    expect(await posterAssets("off", POSTER_THEME, read)).toBeNull();
    expect(await posterAssets("on", CLASSIC_THEME, read)).toBeNull();
  });

  it("puts the theme's poster art in as the artwork Wallet draws, with the theme's own logo for it", async () => {
    expect(decode((await posterAssets("on", POSTER_THEME, read))!)).toEqual({
      "primaryLogo.png": "templates/themes/2026/apple-poster/primaryLogo.png",
      "primaryLogo@2x.png": "templates/themes/2026/apple-poster/primaryLogo@2x.png",
      "primaryLogo@3x.png": "templates/themes/2026/apple-poster/primaryLogo@3x.png",
      "artwork.png": "templates/themes/2026/apple-poster/poster.png",
      "artwork@2x.png": "templates/themes/2026/apple-poster/poster@2x.png",
      "artwork@3x.png": "templates/themes/2026/apple-poster/poster@3x.png",
    });
  });

  it("reads only files that are committed for upload to R2, for every theme with poster art", async () => {
    for (const theme of CARD_THEMES.filter((t) => t.artwork.applePosterPrefix)) {
      const keys = Object.values(decode((await posterAssets("on", theme, read))!));
      for (const key of keys) expect(COMMITTED, `${theme.id}: ${key}`).toContain(key);
    }
  });
});
