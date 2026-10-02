import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/index";
import { CARD_THEMES, CLASSIC_THEME, YEAR_THEMES, type CardTheme } from "../../src/themes/cardTheme";
import { themeArtworkKeys, themeVersion } from "../../src/themes/fingerprint";

/** The bundle's own binding, counting what is asked of it, or failing the first `failures` asks. */
function countingEnv(failures = 0): { env: Env; asked: () => number } {
  let asked = 0;
  const STATIC = {
    fetch: (request: Request) => {
      asked++;
      if (asked <= failures) return Promise.reject(new Error("bundle unreachable"));
      return env.STATIC.fetch(request);
    },
  };
  return { env: { ...env, STATIC } as Env, asked: () => asked };
}

const fresh = (theme: CardTheme, changes: Partial<CardTheme> = {}): CardTheme => ({ ...theme, ...changes });

describe("a theme's version", () => {
  it("is twelve hex digits, the same however often it is asked for", async () => {
    const theme = fresh(YEAR_THEMES[0]);
    const version = await themeVersion(env, theme);

    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(await themeVersion(env, fresh(YEAR_THEMES[0]))).toBe(version);
  });

  it("differs for every theme there is", async () => {
    const versions = await Promise.all(CARD_THEMES.map((theme) => themeVersion(env, theme)));
    expect(new Set(versions).size).toBe(CARD_THEMES.length);
  });

  it("changes with the theme's colours, label or art", async () => {
    const theme = YEAR_THEMES[0];
    const version = await themeVersion(env, fresh(theme));

    expect(await themeVersion(env, fresh(theme, { colors: { ...theme.colors, border: "#123456" } }))).not.toBe(version);
    expect(await themeVersion(env, fresh(theme, { label: "Renamed" }))).not.toBe(version);
    // Another year's card background in its place: a file with other contents.
    const art = { ...theme.artwork, cardBackground: YEAR_THEMES[1].artwork.cardBackground };
    expect(await themeVersion(env, fresh(theme, { artwork: art }))).not.toBe(version);
  });

  it("asks after each file once per theme, not on every pass", async () => {
    const { env: counted, asked } = countingEnv();
    const theme = fresh(YEAR_THEMES[0]);

    await themeVersion(counted, theme);
    await themeVersion(counted, theme);

    expect(asked()).toBe(themeArtworkKeys(theme).length);
  });

  it("asks again after a failed read, rather than remembering the failure", async () => {
    const { env: failing } = countingEnv(1);
    const theme = fresh(YEAR_THEMES[0]);

    await expect(themeVersion(failing, theme)).rejects.toThrow("bundle unreachable");
    expect(await themeVersion(failing, theme)).toBe(await themeVersion(env, fresh(YEAR_THEMES[0])));
  });
});

describe("a theme's art files", () => {
  it("are all in the bundle, for every theme with art", async () => {
    for (const theme of CARD_THEMES) {
      for (const key of themeArtworkKeys(theme)) {
        const res = await env.STATIC.fetch(new Request(`https://templates.invalid/${key}`, { method: "HEAD" }));
        expect(res.status, key).toBe(200);
      }
    }
  });

  it("are none for classic, whose version comes from its colours alone", () => {
    expect(themeArtworkKeys(CLASSIC_THEME)).toEqual([]);
  });

  it("cover every surface a year theme draws", () => {
    expect(themeArtworkKeys(YEAR_THEMES[0])).toHaveLength(1 + 3 + 3 + 3 + 1);
  });
});
