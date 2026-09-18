/**
 * Public, unauthenticated images from R2.
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
import type { Env } from "./index";

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

const assets = new Hono<{ Bindings: Env }>();

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
