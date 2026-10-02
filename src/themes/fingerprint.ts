/**
 * A theme's version, worked out from what it is rather than numbered by hand.
 *
 * Cached passes and card images are tagged with the theme they were built in,
 * and Google's hero image is addressed by it, so a theme whose art or colours
 * change has to look different to all three -- otherwise members keep what
 * was cached and Google keeps its copy of the old hero. That used to be a
 * `version` number on each theme, bumped by hand and easily forgotten.
 *
 * Instead: a short hash of the theme's id, label and colours, and of each of
 * its own art files as the bundle holds them. Workers static assets answer
 * with an ETag that is a hash of the file's contents (src/templates.ts reads
 * them through the `STATIC` binding), so the files are not read, only asked
 * after. Worked out once per theme per isolate (the themes are constants),
 * and the same in every isolate of a deployment, since the files ship with
 * the code.
 *
 * The crest and logos every theme shares are not part of it: a change to how
 * any card or pass is drawn bumps `CARD_IMAGE_VERSION` or
 * `PASS_CONTENT_VERSION` instead.
 */

import type { Env } from "../index";
import { fetchTemplate } from "../templates";
import { PRIMARY_LOGO_FILES } from "../passkit/poster";
import { APPLE_POSTER_FILES, APPLE_THUMBNAIL_FILES, type CardTheme } from "./cardTheme";

/** Every art file of the theme's own, by key. */
export function themeArtworkKeys(theme: CardTheme): string[] {
  const { cardBackground, appleThumbnailPrefix, applePosterPrefix, googleHero } = theme.artwork;
  return [
    ...(cardBackground ? [cardBackground] : []),
    ...(appleThumbnailPrefix ? APPLE_THUMBNAIL_FILES.map((name) => `${appleThumbnailPrefix}${name}`) : []),
    ...(applePosterPrefix
      ? [...APPLE_POSTER_FILES, ...PRIMARY_LOGO_FILES].map((name) => `${applePosterPrefix}${name}`)
      : []),
    ...(googleHero ? [googleHero] : []),
  ];
}

const versions = new WeakMap<CardTheme, Promise<string>>();

/** The theme's version: 12 hex digits, changing whenever its colours, label or art do. */
export function themeVersion(env: Env, theme: CardTheme): Promise<string> {
  let version = versions.get(theme);
  if (!version) {
    version = computeVersion(env, theme);
    versions.set(theme, version);
    // A failed read is not remembered: the next request asks again.
    version.catch(() => versions.delete(theme));
  }
  return version;
}

async function computeVersion(env: Env, theme: CardTheme): Promise<string> {
  const files = await Promise.all(
    themeArtworkKeys(theme).map(async (key) => {
      const res = await fetchTemplate(env, key, { method: "HEAD" });
      await res.body?.cancel();
      return [key, res.ok ? (res.headers.get("ETag") ?? "") : `missing ${res.status}`];
    }),
  );
  const described = JSON.stringify({ id: theme.id, label: theme.label, colors: theme.colors, files });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(described)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
