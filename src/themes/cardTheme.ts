/**
 * What a membership card looks like (#333).
 *
 * The card image, the Apple pass, the Google pass and the emailed card all
 * take their colours and images from a theme rather than from constants of
 * their own, so that a member's card can be drawn in a year's theme or a
 * subgroup's, and so the four cannot drift apart.
 *
 * "Classic" is today's look, and the only theme so far. It is also the
 * fallback wherever a theme is missing: a year with no scarf design, or a
 * chosen theme that is no longer allowed.
 */

/** Colours, as `#rrggbb`. One background serves every surface, so a card looks the same in every wallet. */
export interface CardThemeColors {
  /** Card background, Apple `backgroundColor`, Google `hexBackgroundColor`. */
  background: string;
  /** The card image's border. */
  border: string;
  /** The card image's title and name. */
  text: string;
  /** The card image's "Member since" and "Good through" lines. */
  secondaryText: string;
  /** The card number under the QR code, which sits on a white box. */
  qrLabel: string;
  /** Apple pass text (`foregroundColor`). Separate because the pass and the card image need not agree. */
  passText: string;
}

/** Where a theme's images live. R2 keys are uploaded from `assets/` by `just r2-upload-templates`. */
export interface CardThemeAssets {
  /** R2 key of the crest drawn on the card image (square, at least `CREST_SIZE`). */
  cardCrest: string;
  /** R2 prefix holding the Apple pass's `icon.png`, `icon@2x.png`, `logo.png` and `logo@2x.png`. */
  applePrefix: string;
  /** Public path of the logo Google fetches for the pass (served by `src/assets.ts`). */
  googleLogoPath: string;
}

export interface CardTheme {
  /** Stable identifier, stored against a member's choice. */
  id: string;
  /** What a member sees when choosing. */
  label: string;
  /**
   * Bump when this theme's colours or images change. Cached Apple passes are
   * tagged with it, so a changed theme is not served from an old cache (the
   * same discipline as `PASS_CONTENT_VERSION`, for one theme rather than all).
   */
  version: number;
  colors: CardThemeColors;
  assets: CardThemeAssets;
}

export const CLASSIC_THEME: CardTheme = {
  id: "classic",
  label: "Classic",
  version: 1,
  colors: {
    background: "#00b140",
    border: "#046a29",
    text: "#ffffff",
    secondaryText: "#d8f5e4",
    qrLabel: "#00b140",
    passText: "#000000",
  },
  assets: {
    cardCrest: "templates/card/crest.png",
    applePrefix: "templates/apple/",
    googleLogoPath: "/assets/crest.png",
  },
};

/**
 * The theme a member's card is drawn in. Every card is "classic" until
 * members can choose (#333, pieces 3 and 4); callers go through this so that
 * change lands in one place.
 */
export function resolveCardTheme(): CardTheme {
  return CLASSIC_THEME;
}

/** Tags a cached pass with the theme it was built in; see `CardTheme.version`. */
export function themeCacheTag(theme: CardTheme): string {
  return `${theme.id}@${theme.version}`;
}

/** `#rrggbb` as Apple's `rgb(r, g, b)`, the only colour form a pass accepts. */
export function appleRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16));
  return `rgb(${r}, ${g}, ${b})`;
}
