import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_CSS, VERDE } from "../src/styles";

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
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
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
const TEXT_TOKENS = ["--ink", "--muted", "--danger", "--success", "--warn"];

describe("the colour tokens", () => {
  it("resolve to plain hex, so contrast can be reasoned about at all", () => {
    for (const palette of [LIGHT, DARK]) {
      for (const name of [...TEXT_TOKENS, "--verde", "--bg", "--rule"]) {
        expect(palette[name], name).toMatch(/^#[0-9a-fA-F]{6}$/);
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

  it("the group's green reads on dark, where on white it does not (#143)", () => {
    // Recorded rather than asserted both ways round: #00B140 on white is
    // 2.85:1, below every WCAG threshold, and it is the brand colour --
    // changing it is not a decision this stylesheet gets to make alone.
    expect(contrast(DARK["--verde"], DARK["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(VERDE, "#ffffff")).toBeLessThan(3);
  });
});

describe("pages keep their colours in the stylesheet", () => {
  // The rule dark mode depends on: a hex literal in a `style` attribute
  // cannot respond to prefers-color-scheme, so each one is a patch of light
  // mode surviving on a dark page.
  const PAGES = [
    "src/admin/layout.tsx",
    "src/admin/memberSince.tsx",
    "src/admin/orders.tsx",
    "src/admin/preflight.tsx",
    "src/admin/reports.tsx",
    "src/auth/loginPage.tsx",
    "src/member/email-card.tsx",
    "src/member/layout.tsx",
    "src/member/portal.tsx",
    "src/member/verify-pass.tsx",
  ];

  it.each(PAGES)("%s names no colour of its own", (path) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const inStyleAttributes = source.matchAll(/style="([^"]*)"/g);
    for (const [, declarations] of inStyleAttributes) {
      expect(declarations, path).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });

  it("leaves the emailed card alone, which cannot use the stylesheet", () => {
    // Mail clients neither fetch /assets/app.css nor honour the media query
    // dependably, so that one template keeps inline, light colours on
    // purpose. Asserted so a later sweep doesn't "fix" it.
    const email = readFileSync(new URL("../src/email/card.tsx", import.meta.url), "utf8");
    expect(email).toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
