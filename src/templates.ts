/**
 * The template images committed under `assets/templates/` -- crests, pass
 * images, theme art -- bundled with each Worker version as static assets
 * (the `STATIC` binding, #399). They deploy and roll back with the code that
 * reads them, so a key named in code and a file missing from the bundle is a
 * mistake in the commit, never drift between environments.
 */

import type { Env } from "./index";

/** A template image by its key (`templates/...`), as the bundle's own response: 404 when absent. */
export function fetchTemplate(env: Env, key: string, init?: RequestInit): Promise<Response> {
  return env.STATIC.fetch(new Request(`https://templates.invalid/${key}`, init));
}
