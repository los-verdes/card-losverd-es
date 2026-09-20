/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { APP_CSS, VERDE, VERDE_INK } from "../src/styles";

/**
 * WCAG 2.1 relative luminance and contrast. Worth the dozen lines: dark mode
 * is entirely a legibility feature, and a colour that disappears against its
 * background is exactly the defect nobody notices in review because the
 * reviewer's own device is in the other mode.
 */
function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  // `#555` is as valid as `#555555` and CSS authors write both, so expand the
  // short form rather than quietly reading it as NaN.
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The custom properties declared in one `:root { ... }` block. */
function tokensIn(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function rootBlock(css: string): string {
  const match = css.match(/^:root \{([^}]*)\}/m);
  if (!match) throw new Error("no top-level :root block");
  return match[1];
}

function darkBlock(css: string): string {
  const match = css.match(
    /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/,
  );
  if (!match) throw new Error("no dark-mode :root block");
  return match[1];
}

const LIGHT = tokensIn(rootBlock(APP_CSS));
const DARK = { ...LIGHT, ...tokensIn(darkBlock(APP_CSS)) };

/** Everything that renders as text on the page background. */
const TEXT_TOKENS = ["--ink", "--muted", "--danger", "--success", "--warn", "--verde-ink"];

describe("the colour tokens", () => {
  it("resolve to plain hex, so contrast can be reasoned about at all", () => {
    for (const palette of [LIGHT, DARK]) {
      for (const name of [...TEXT_TOKENS, "--verde", "--bg", "--rule"]) {
        expect(palette[name], name).toMatch(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/);
      }
    }
  });

  it("declares color-scheme, so the browser dark-renders what CSS doesn't cover", () => {
    // Form fields, scrollbars and the canvas behind a short page are the
    // browser's to paint; without this they stay light and the page frays.
    expect(rootBlock(APP_CSS)).toMatch(/color-scheme:\s*light dark/);
  });

  it("restates every colour it overrides, leaving none half-inverted", () => {
    // A token left behind keeps its light value against a dark background,
    // which is the specific way a partial dark mode goes wrong.
    const overridden = Object.keys(tokensIn(darkBlock(APP_CSS)));
    expect(overridden).toEqual(expect.arrayContaining([...TEXT_TOKENS, "--bg", "--rule"]));
  });

  it("actually inverts: the dark background is darker than its text", () => {
    expect(luminance(DARK["--bg"])).toBeLessThan(luminance(LIGHT["--bg"]));
    expect(luminance(DARK["--ink"])).toBeGreaterThan(luminance(DARK["--bg"]));
    expect(luminance(LIGHT["--ink"])).toBeLessThan(luminance(LIGHT["--bg"]));
  });
});

describe("contrast against the page background", () => {
  it.each(TEXT_TOKENS)("%s is legible in light mode", (token) => {
    expect(contrast(LIGHT[token], LIGHT["--bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TEXT_TOKENS)("%s is legible in dark mode", (token) => {
    expect(contrast(DARK[token], DARK["--bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the rule visible without it becoming a second text colour", () => {
    // A hairline only has to be seen, not read, but an invisible table
    // border is why a dark admin page reads as one undifferentiated block.
    for (const palette of [LIGHT, DARK]) {
      expect(contrast(palette["--rule"], palette["--bg"])).toBeGreaterThan(1.15);
    }
  });

  it("keeps Bright Verde for artwork and a verde that reads for text (#143)", () => {
    // #00B140 on white is 2.85:1, below every WCAG threshold, and it is the
    // brand colour, so it stays -- for the card tint -- and text gets the
    // darker verde the card image already borders it with. Asserted both
    // ways so that a later tidy-up cannot quietly point text back at it.
    expect(contrast(VERDE, "#ffffff")).toBeLessThan(3);
    expect(contrast(LIGHT["--verde-ink"], LIGHT["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(LIGHT["--verde-ink"].toLowerCase()).toBe(VERDE_INK.toLowerCase());
    // On a dark page Bright Verde itself reads, so the text token becomes it
    // rather than keeping a shade that would fail there.
    expect(DARK["--verde-ink"].toLowerCase()).toBe(VERDE.toLowerCase());
    expect(contrast(DARK["--verde-ink"], DARK["--bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("button labels read on the button in both modes", () => {
    // The label is var(--bg): white on the dark verde by day, near-black on
    // Bright Verde by night. White on Bright Verde would be the 2.85:1 case.
    for (const palette of [LIGHT, DARK]) {
      expect(contrast(palette["--bg"], palette["--verde-ink"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("nothing that has to be read is drawn in Bright Verde on a light page", () => {
    // The rules that carry text or a control outline all use --verde-ink;
    // --verde is left to the card tint. Checked on the CSS text so a new
    // rule cannot reach for the brand colour out of habit.
    for (const selector of ["h1, h2, h3", "a", "button", ".action", "ul.checklist input"]) {
      const at = APP_CSS.indexOf("\n" + selector + " {");
      expect(at, selector).toBeGreaterThan(-1);
      const block = APP_CSS.slice(at, APP_CSS.indexOf("}", at));
      expect(block, selector).not.toContain("var(--verde)");
      expect(block, selector).toContain("var(--verde-ink)");
    }
  });
});

describe("pages keep their colours in the stylesheet", () => {
  // The rule dark mode depends on: a hex literal in a `style` attribute
  // cannot respond to prefers-color-scheme, so each one is a patch of light
  // mode surviving on a dark page.
  //
  // Globbed rather than listed. Vite inlines these at transform time, which
  // matters twice over: the Workers test pool has no working `node:fs`, and a
  // hardcoded list silently stops covering pages added after it was written.
  const SOURCES = import.meta.glob("../src/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /** Mail templates are exempt -- see the emailed-card test below. */
  const pages = Object.entries(SOURCES).filter(([path]) => !path.includes("/email/"));

  it("finds pages to check at all, rather than passing on an empty glob", () => {
    expect(pages.length).toBeGreaterThan(5);
  });

  it.each(pages)("%s names no colour of its own", (_path, source) => {
    for (const [, declarations] of source.matchAll(/style="([^"]*)"/g)) {
      // `var(--danger, #b00020)` is allowed: the fallback only applies where
      // the token is undefined, so it cannot strand a page in light mode.
      const literal = declarations.replace(/var\(--[a-z-]+,\s*#[0-9a-fA-F]{3,6}\)/g, "");
      expect(literal).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });

  it("leaves the emailed card alone, which cannot use the stylesheet", () => {
    // Mail clients neither fetch /assets/app.css nor honour the media query
    // dependably, so that one template keeps inline, light colours on
    // purpose. Asserted so a later sweep doesn't "fix" it.
    expect(SOURCES["../src/email/card.tsx"]).toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
