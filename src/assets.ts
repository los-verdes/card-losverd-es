/**
 * Public, unauthenticated assets: the stylesheet and display font bundled
 * into the Worker, and an allow-list of images from R2.
 *
 * This exists because Google Wallet will not accept a pass logo as bytes: a
 * `GenericObject` names it as a URL (`logo.sourceUri`) and Google's servers
 * fetch it themselves, so at least one of the template images has to be
 * reachable without a session. Everything else the app serves is behind a
 * login.
 *
 * Only an explicit allow-list is served. The same bucket holds the Apple pass
 * templates and whatever else deploys put there, so a route that mapped its
 * path straight onto an R2 key would publish the bucket's future contents by
 * default -- a decision nobody would be making deliberately.
 */

import { Hono } from "hono";
import bungeeFont from "./cardimage/assets/bungee-latin-400-normal.woff";
import { siteEnvironment } from "./environment";
import type { Env } from "./index";
import { APP_CSS, STYLESHEET_PATH, VERDE } from "./styles";
import { CARD_THEMES, googleHeroFileName, type CardTheme } from "./themes/cardTheme";

/**
 * Public file name -> R2 key: the crest Google shows as the pass logo, and
 * each theme's Google hero image, which Google fetches the same way.
 */
export function publicAssets(themes: readonly CardTheme[]): Record<string, string> {
  return {
    "crest.png": "templates/card/crest.png",
    ...Object.fromEntries(
      themes.flatMap((theme) =>
        theme.artwork.googleHero ? [[googleHeroFileName(theme), theme.artwork.googleHero]] : [],
      ),
    ),
  };
}

export const PUBLIC_ASSETS = publicAssets(CARD_THEMES);

/**
 * A day. These images change only when the branding does, and Google caches
 * the logo on its own side regardless, so there is little to gain from a
 * longer life and a stale logo is awkward to flush.
 */
const MAX_AGE_SECONDS = 86_400;

/**
 * A year, for the font. Its bytes are fixed for a given file name -- a
 * different font would be a different file -- so there is nothing to
 * invalidate. The stylesheet earns the same treatment by carrying a hash of
 * its contents in its path (src/styles.ts).
 *
 * The favicon keeps an hour. It could be versioned the same way, but a stale
 * one costs an out-of-date square in a tab strip rather than an unstyled
 * page, and it is linked from the same two shells that would have to change
 * to version it -- not worth the machinery for that.
 */
const IMMUTABLE_SECONDS = 31_536_000;
const FAVICON_MAX_AGE_SECONDS = 3_600;

/**
 * The favicon, authored here rather than bundled as a file.
 *
 * A crest does not survive 16 pixels -- `templates/card/crest.png` is 53 KB
 * of detail that becomes a smudge in a tab strip -- so this is a mark that
 * reads at that size: the group's verde, and `LV` drawn as stroked paths
 * rather than set as text, so there is no font to resolve and no hinting to
 * go wrong at 16 pixels.
 *
 * Both letters are needed: the group is Los Verdes, and a lone V is not its
 * mark. They are drawn as two open paths with round caps, sized so the ink
 * clears the rounded corners and keeps about one stroke-width of air between
 * the L and the V -- at 16 pixels that gap is under a pixel, and closing it
 * any further reads as a single smudged glyph.
 *
 * SVG rather than ICO because it is a string, which means it bundles like
 * the stylesheet, scales to every size a browser asks for, and can be read
 * and changed in a diff.
 */
function faviconSvg(background: string, ink: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${background}"/>
  <g fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.2 9.5V21.8H13.1"/>
    <path d="M17.6 9.5L21.5 21.8L25.4 9.5"/>
  </g>
</svg>`;
}

export const FAVICON_SVG = faviconSvg(VERDE, "#fff");

/**
 * Every environment but production gets the same mark in verde on black, so
 * its tabs can be told apart from production's at a glance (#338).
 */
export const STAGING_FAVICON_SVG = faviconSvg("#000", VERDE);

const assets = new Hono<{ Bindings: Env }>();

// Bundled rather than in R2, and so declared before the R2 handler below:
// both are fetched by a browser on the first page it renders, and neither
// should depend on the bucket having been populated by a deploy.
// Named after its own contents, so a browser either holds this exact
// stylesheet or fetches it -- the HTML can never ask for a rule its CSS has
// not got. That is what makes caching it forever safe, and the hour-long
// compromise it replaces was what broke the card image on phones (#174).
assets.get(STYLESHEET_PATH.replace("/assets", ""), (c) =>
  c.body(APP_CSS, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": `public, max-age=${IMMUTABLE_SECONDS}, immutable`,
  }),
);


// The same face the card image is rendered with (src/cardimage/render.ts),
// so a member's card and the page around it agree.
assets.get("/bungee.woff", (c) =>
  c.body(bungeeFont, 200, {
    "Content-Type": "font/woff",
    "Cache-Control": `public, max-age=${IMMUTABLE_SECONDS}, immutable`,
  }),
);

// Every page links this, so a browser asks for it once per session rather
// than falling back to /favicon.ico and being answered with a 404 on every
// page view. Each environment has its own hostname, so caching one answer per
// environment for the hour is safe.
assets.get("/favicon.svg", (c) =>
  c.body(siteEnvironment(c.env.ENVIRONMENT) === "production" ? FAVICON_SVG : STAGING_FAVICON_SVG, 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": `public, max-age=${FAVICON_MAX_AGE_SECONDS}`,
  }),
);

assets.get("/:name", async (c) => {
  const key = PUBLIC_ASSETS[c.req.param("name")];
  if (!key) {
    return c.notFound();
  }

  const object = await c.env.ASSETS.get(key);
  if (!object) {
    // Deploy uploads these (`just r2-upload-templates`), so a miss means the
    // bucket and the code have drifted apart rather than a bad request.
    console.error(`GET /assets: ${key} is missing from R2`);
    return c.notFound();
  }

  if (c.req.header("If-None-Match") === object.httpEtag) {
    return c.body(null, 304, { ETag: object.httpEtag });
  }

  return c.body(object.body, 200, {
    "Content-Type": "image/png",
    "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}`,
    ETag: object.httpEtag,
  });
});

export default assets;
