import { describe, expect, it } from "vitest";
import { CLASSIC_THEME, appleRgb, resolveCardTheme, themeCacheTag } from "../../src/themes/cardTheme";

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
      googleLogoPath: "/assets/crest.png",
    });
  });

  it("uses only #rrggbb colours, which every surface can take", () => {
    for (const colour of Object.values(CLASSIC_THEME.colors)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("is what every card is drawn in, until members can choose", () => {
    expect(resolveCardTheme()).toBe(CLASSIC_THEME);
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
