import { describe, expect, it } from "vitest";
import {
  APPLE_POSTER_FILES,
  APPLE_THUMBNAIL_FILES,
  ARTWORK_SIZES,
  CARD_THEMES,
  CLASSIC_THEME,
  YEAR_THEMES,
  appleRgb,
  googleHeroFileName,
  googleHeroPath,
  themeCacheTag,
  type CardTheme,
} from "../../src/themes/cardTheme";
import { CARD_HEIGHT, CARD_WIDTH } from "../../src/cardimage/template";
import { contrast } from "../fixtures/contrast";

// Every image committed for upload to R2 (`just r2-upload-templates`), keyed
// by its R2 key. Only the paths are needed, so nothing is loaded.
const COMMITTED_ASSETS = new Set(
  Object.keys(import.meta.glob("../../assets/templates/**/*.png")).map((path) =>
    path.replace("../../assets/", ""),
  ),
);

// The committed images' bytes, keyed the same way.
const ASSET_BYTES = Object.fromEntries(
  Object.entries(
    import.meta.glob<ArrayBuffer>("../../assets/templates/themes/**/*.png", { eager: true, import: "default" }),
  ).map(([path, bytes]) => [path.replace("../../assets/", ""), bytes]),
);

/** A PNG's width and height: the two big-endian words after the IHDR tag. */
function pngSize(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A theme with every artwork slot filled, as a year theme would be. */
const ARTWORK_THEME: CardTheme = {
  ...CLASSIC_THEME,
  id: "2026",
  label: "2026",
  version: 2,
  artwork: {
    cardBackground: "templates/themes/2026/card-background.png",
    appleThumbnailPrefix: "templates/themes/2026/apple/",
    googleHero: "templates/themes/2026/google-hero.png",
  },
};

describe("the classic theme", () => {
  it("is today's look, colour for colour", () => {
    // What the card, the Apple pass and the Google pass used before themes
    // existed; a change here changes every card in circulation.
    expect(CLASSIC_THEME.colors).toEqual({
      background: "#00b140",
      border: "#046a29",
      text: "#ffffff",
      secondaryText: "#d8f5e4",
      qrLabel: "#00b140",
      passText: "#000000",
    });
    expect(CLASSIC_THEME.assets).toEqual({
      cardCrest: "templates/card/crest.png",
      applePrefix: "templates/apple/",
      googleLogoPath: "/assets/google-logo-2.png",
    });
  });

  it("has no artwork, so no surface changes", () => {
    expect(CLASSIC_THEME.artwork).toEqual({});
    expect(googleHeroPath(CLASSIC_THEME)).toBeNull();
  });

  it("uses only #rrggbb colours, which every surface can take", () => {
    for (const colour of Object.values(CLASSIC_THEME.colors)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("tags a cached pass with its id and version", () => {
    expect(themeCacheTag(CLASSIC_THEME)).toBe("classic@1");
    expect(themeCacheTag({ ...CLASSIC_THEME, id: "2026", version: 3 })).toBe("2026@3");
  });
});

describe("appleRgb", () => {
  it.each([
    ["#00b140", "rgb(0, 177, 64)"],
    ["#000000", "rgb(0, 0, 0)"],
    ["#FFFFFF", "rgb(255, 255, 255)"],
  ])("writes %s as %s", (hex, rgb) => {
    expect(appleRgb(hex)).toBe(rgb);
  });

  it.each(["00b140", "#0b1", "#00b14", "green", "#00b14g"])("refuses %s rather than send Apple a colour it cannot read", (bad) => {
    expect(() => appleRgb(bad)).toThrow("Not a #rrggbb colour");
  });
});

describe("the theme registry", () => {
  it("starts with classic, the fallback, and has no duplicate ids", () => {
    expect(CARD_THEMES[0]).toBe(CLASSIC_THEME);
    const ids = CARD_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only images that are committed for upload to R2", () => {
    const APPLE_PASS_FILES = ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"];
    for (const theme of CARD_THEMES) {
      const keys = [
        theme.assets.cardCrest,
        ...APPLE_PASS_FILES.map((name) => `${theme.assets.applePrefix}${name}`),
        theme.artwork.cardBackground,
        ...(theme.artwork.appleThumbnailPrefix
          ? APPLE_THUMBNAIL_FILES.map((name) => `${theme.artwork.appleThumbnailPrefix}${name}`)
          : []),
        theme.artwork.googleHero,
        ...(theme.artwork.applePosterPrefix
          ? APPLE_POSTER_FILES.map((name) => `${theme.artwork.applePosterPrefix}${name}`)
          : []),
      ].filter((key): key is string => Boolean(key));
      for (const key of keys) {
        expect(COMMITTED_ASSETS, `${theme.id}: ${key}`).toContain(key);
      }
    }
  });
});

describe("artwork", () => {
  it("is specified at the card image's own size", () => {
    expect(ARTWORK_SIZES.cardBackground).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
  });

  it("names one Apple thumbnail file per scale", () => {
    expect(APPLE_THUMBNAIL_FILES).toHaveLength(ARTWORK_SIZES.appleThumbnail.scales.length);
  });

  it("serves a theme's Google hero image at an address that changes with the theme's version", () => {
    expect(googleHeroFileName(ARTWORK_THEME)).toBe("hero-2026-2.png");
    expect(googleHeroPath(ARTWORK_THEME)).toBe("/assets/hero-2026-2.png");
    expect(googleHeroPath({ ...ARTWORK_THEME, version: 3 })).toBe("/assets/hero-2026-3.png");
  });
});

describe("the year themes", () => {
  it("are one per year, each id its year, in year order after classic", () => {
    expect(CARD_THEMES.slice(1)).toEqual(YEAR_THEMES);
    expect(YEAR_THEMES.map((theme) => theme.id)).toEqual(YEAR_THEMES.map((theme) => String(theme.year)));
    const years = YEAR_THEMES.map((theme) => theme.year!);
    expect(years).toEqual([...years].sort());
  });

  it.each(YEAR_THEMES.map((theme) => [theme.id, theme] as const))("%s fills every artwork slot, at the size each surface needs", (_, theme) => {
    const { cardBackground, appleThumbnailPrefix, googleHero } = theme.artwork;
    expect(theme.artwork.applePosterPrefix).toBeDefined();

    expect(pngSize(ASSET_BYTES[cardBackground!])).toEqual(ARTWORK_SIZES.cardBackground);
    expect(pngSize(ASSET_BYTES[googleHero!])).toEqual(ARTWORK_SIZES.googleHero);
    ARTWORK_SIZES.applePoster.scales.forEach((scale, i) => {
      expect(pngSize(ASSET_BYTES[`${theme.artwork.applePosterPrefix}${APPLE_POSTER_FILES[i]}`])).toEqual({
        width: ARTWORK_SIZES.applePoster.width * scale,
        height: ARTWORK_SIZES.applePoster.height * scale,
      });
    });
    ARTWORK_SIZES.appleThumbnail.scales.forEach((scale, i) => {
      const side = ARTWORK_SIZES.appleThumbnail.width * scale;
      expect(pngSize(ASSET_BYTES[`${appleThumbnailPrefix}${APPLE_THUMBNAIL_FILES[i]}`])).toEqual({ width: side, height: side });
    });
  });

  // Against the theme's background colour, which the passes use as it is and
  // the card's art is toned to match: darkened under white text, or kept light
  // under dark text. The card's title and name are large text (3:1); the rest
  // is small (4.5:1). Classic predates the check, and its white on verde falls
  // short of 3:1, so it is left as every card has always been.
  it.each(YEAR_THEMES.map((theme) => [theme.id, theme.colors] as const))("%s keeps its text legible", (_, colors) => {
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.secondaryText, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.passText, colors.background)).toBeGreaterThanOrEqual(4.5);
    // The card number sits on the QR code's white box.
    expect(contrast(colors.qrLabel, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
