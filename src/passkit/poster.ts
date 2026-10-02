/**
 * Apple's poster layout for generic passes (iOS 27, #384): a `posterGeneric`
 * block beside the pass's `generic` one, and the theme's art drawn behind the
 * whole pass. Older iOS versions read only `generic`, so the pass they show is
 * unchanged.
 *
 * Checked on an iPhone running iOS 27 (2026-09-29): Wallet draws the art from
 * `artwork.png` (not `background.png`, which Apple's own sample code uses), and
 * a pass already installed switches to the poster layout on its next update.
 *
 * Pure, like the rest of src/passkit: the caller reads R2 and passes a reader
 * in.
 */

import type { Env } from "../index";
import { APPLE_POSTER_FILES, type CardTheme } from "../themes/cardTheme";

export type ApplePosterMode = "off" | "on";

/** `APPLE_POSTER_PASSES`, read in one place. Anything but "on" is "off". */
export function applePosterMode(env: Pick<Env, "APPLE_POSTER_PASSES">): ApplePosterMode {
  return env.APPLE_POSTER_PASSES?.trim().toLowerCase() === "on" ? "on" : "off";
}

/** The pass's name for each file in `APPLE_POSTER_FILES`, one per scale. */
const ARTWORK_FILES = ["artwork.png", "artwork@2x.png", "artwork@3x.png"] as const;

/**
 * The small logo the poster layout draws at its top in place of `logo`, kept
 * with each theme's poster art: the same mark, light over dark art and dark
 * over light, since it sits straight on the art.
 */
export const PRIMARY_LOGO_FILES = ["primaryLogo.png", "primaryLogo@2x.png", "primaryLogo@3x.png"] as const;

/**
 * The files a pass needs for the poster layout, or `null` when it does not
 * get one: the mode is off, or the theme has no poster art.
 */
export async function posterAssets(
  mode: ApplePosterMode,
  theme: CardTheme,
  read: (key: string) => Promise<Uint8Array>,
): Promise<Record<string, Uint8Array> | null> {
  const posterPrefix = theme.artwork.applePosterPrefix;
  if (mode === "off" || !posterPrefix) return null;

  const files: Record<string, Uint8Array> = {};
  for (const name of PRIMARY_LOGO_FILES) {
    files[name] = await read(`${posterPrefix}${name}`);
  }
  for (const [i, name] of ARTWORK_FILES.entries()) {
    files[name] = await read(`${posterPrefix}${APPLE_POSTER_FILES[i]}`);
  }
  return files;
}
