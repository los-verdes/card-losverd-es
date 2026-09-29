/**
 * Apple's poster layout for generic passes (iOS 27, #384): a `posterGeneric`
 * block beside the pass's `generic` one, and an image drawn behind the whole
 * pass. Older iOS versions read only `generic`, so the pass they show is
 * unchanged.
 *
 * Which image name the layout draws is not settled: Apple's own pass tooling
 * lists both a portrait `background` (345 x 505 points) and a portrait
 * `artwork` (358 x 448). Until a pass on an iOS 27 device settles it, the art
 * goes in under both names, and staging's "probe" mode puts a different
 * labelled image under each, so one look at the pass says which is drawn.
 *
 * Pure, like the rest of src/passkit: the caller reads R2 and passes a reader
 * in.
 */

import type { Env } from "../index";
import { APPLE_POSTER_FILES, type CardTheme } from "../themes/cardTheme";

export type ApplePosterMode = "off" | "probe" | "on";

/** `APPLE_POSTER_PASSES`, read in one place. Anything unrecognised is "off". */
export function applePosterMode(env: Pick<Env, "APPLE_POSTER_PASSES">): ApplePosterMode {
  const value = env.APPLE_POSTER_PASSES?.trim().toLowerCase();
  return value === "probe" || value === "on" ? value : "off";
}

/** The image names a poster pass's art may be read under; see the note at the top. */
export const POSTER_IMAGE_NAMES = ["background", "artwork"] as const;

/** R2 prefix of the probe's labelled images, one set per name in `POSTER_IMAGE_NAMES`. */
export const POSTER_PROBE_PREFIX = "templates/apple/poster-probe/";

/** The small logo the poster layout draws at its top, in place of `logo`. Ours already fits its 126 x 30. */
const PRIMARY_LOGO_SOURCES: Record<string, string> = {
  "primaryLogo.png": "logo.png",
  "primaryLogo@2x.png": "logo@2x.png",
};

const SCALE_SUFFIXES = ["", "@2x", "@3x"] as const;

/**
 * The files a pass needs for the poster layout, or `null` when it does not
 * get one: the mode is off, or it is on and the theme has no poster art.
 */
export async function posterAssets(
  mode: ApplePosterMode,
  theme: CardTheme,
  read: (key: string) => Promise<Uint8Array>,
): Promise<Record<string, Uint8Array> | null> {
  const posterPrefix = theme.artwork.applePosterPrefix;
  if (mode === "off" || (mode === "on" && !posterPrefix)) return null;

  const files: Record<string, Uint8Array> = {};
  for (const [name, source] of Object.entries(PRIMARY_LOGO_SOURCES)) {
    files[name] = await read(`${theme.assets.applePrefix}${source}`);
  }
  for (const imageName of POSTER_IMAGE_NAMES) {
    for (const [i, suffix] of SCALE_SUFFIXES.entries()) {
      files[`${imageName}${suffix}.png`] = await read(
        mode === "probe"
          ? `${POSTER_PROBE_PREFIX}${imageName}${suffix}.png`
          : `${posterPrefix}${APPLE_POSTER_FILES[i]}`,
      );
    }
  }
  return files;
}
