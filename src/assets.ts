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
import type { Env } from "./index";
import { APP_CSS, STYLESHEET_PATH, VERDE } from "./styles";

/** Public file name -> R2 key. */
export const PUBLIC_ASSETS: Record<string, string> = {
  "crest.png": "templates/card/crest.png",
};

/**
 * A day. These images change only when the branding does, and Google caches
 * the logo on its own side regardless, so there is little to gain from a
 * longer life and a stale logo is awkward to flush.
 */
const MAX_AGE_SECONDS = 86_400;

/**
 * A year, for the font. Its bytes are fixed for a given file name -- a
 * different font would be a different file -- so there is nothing to
 * invalidate. The stylesheet gets an hour instead, since it changes with
 * deploys and an hour is a tolerable wait for a colour to be corrected.
 */
const IMMUTABLE_SECONDS = 31_536_000;
const STYLESHEET_MAX_AGE_SECONDS = 3_600;

/**
 * The favicon, authored here rather than bundled as a file.
 *
 * A crest does not survive 16 pixels -- `templates/card/crest.png` is 53 KB
 * of detail that becomes a smudge in a tab strip -- so this is a mark that
 * reads at that size: the group's green, and a single stroked V. Two shapes,
 * high contrast, no text, no font to resolve.
 *
 * SVG rather than ICO because it is a string, which means it bundles like
 * the stylesheet, scales to every size a browser asks for, and can be read
 * and changed in a diff.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${VERDE}"/>
  <path d="M9.5 9.5 16 22.5 22.5 9.5" fill="none" stroke="#fff" stroke-width="4"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

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

// The unversioned path stays as a fallback for anything still asking for it
// -- a tab opened before this shipped, a bookmark, a copied link. Nothing
// this app renders links it any more, so it is kept on the old short cache
// rather than promoted.
assets.get("/app.css", (c) =>
  c.body(APP_CSS, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": `public, max-age=${STYLESHEET_MAX_AGE_SECONDS}`,
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
// page view.
assets.get("/favicon.svg", (c) =>
  c.body(FAVICON_SVG, 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": `public, max-age=${STYLESHEET_MAX_AGE_SECONDS}`,
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
