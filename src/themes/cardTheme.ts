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

/**
 * The artwork a theme draws on each surface: for a year, that year's scarf
 * design. Each slot is optional, and a surface whose slot is empty looks the
 * way it does today; "classic" leaves them all empty.
 *
 * The formats differ in what they can take. Only the card image can carry
 * full background art; Apple's generic pass takes a thumbnail beside the
 * member's name, and Google's a hero image across the bottom of the pass.
 * Sizes are in `ARTWORK_SIZES`.
 */
export interface CardThemeArtwork {
  /** R2 key of the card image's background art (`ARTWORK_SIZES.cardBackground`), drawn under everything else. */
  cardBackground?: string;
  /** R2 prefix holding the Apple pass's `thumbnail.png`, `thumbnail@2x.png` and `thumbnail@3x.png`. */
  appleThumbnailPrefix?: string;
  /** R2 key of the Google pass's hero image, served publicly at `googleHeroPath()`. */
  googleHero?: string;
}

/**
 * What each artwork slot needs, in pixels.
 *
 * - The card image is drawn at exactly this size, so art at any other size is
 *   stretched to fit. Its rounded corners and border cover the edges.
 * - Apple draws the thumbnail at 90 x 90 points, and accepts an aspect ratio
 *   between 2:3 and 3:2; each file is that size at 1x, 2x and 3x.
 * - Google wants a hero image 1032 pixels wide, at 3:1 or wider.
 */
export const ARTWORK_SIZES = {
  cardBackground: { width: 1050, height: 660 },
  appleThumbnail: { width: 90, height: 90, scales: [1, 2, 3] },
  googleHero: { width: 1032, height: 336 },
} as const;

/** The Apple thumbnail's file names, one per scale in `ARTWORK_SIZES.appleThumbnail`. */
export const APPLE_THUMBNAIL_FILES = ["thumbnail.png", "thumbnail@2x.png", "thumbnail@3x.png"] as const;

export interface CardTheme {
  /** Stable identifier, stored against a member's choice. */
  id: string;
  /** What a member sees when choosing. */
  label: string;
  /**
   * The calendar year a year theme belongs to; absent for any other theme.
   * Who may use it is `themeOptions()`'s to answer (src/themes/eligibility.ts).
   */
  year?: number;
  /**
   * Bump when this theme's colours or images change. Cached Apple passes are
   * tagged with it, so a changed theme is not served from an old cache (the
   * same discipline as `PASS_CONTENT_VERSION`, for one theme rather than all).
   */
  version: number;
  colors: CardThemeColors;
  assets: CardThemeAssets;
  artwork: CardThemeArtwork;
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
  artwork: {},
};

/** Every theme there is. Classic stays first: it is the fallback. */
export const CARD_THEMES: readonly CardTheme[] = [CLASSIC_THEME];

/**
 * The public file name of a theme's Google hero image, served by
 * `src/assets.ts`. It carries the theme's version, because Google keeps its
 * own copy of an image and fetches it again only when the address changes.
 */
export function googleHeroFileName(theme: CardTheme): string {
  return `hero-${theme.id}-${theme.version}.png`;
}

/** The public path of a theme's Google hero image, or `null` for a theme without one. */
export function googleHeroPath(theme: CardTheme): string | null {
  return theme.artwork.googleHero ? `/assets/${googleHeroFileName(theme)}` : null;
}

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
