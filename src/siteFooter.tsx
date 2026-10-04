/**
 * The line at the foot of every page, member and admin alike: the way back to
 * this site's own front door, the group's store, the privacy policy, and an
 * invitation to help with this one. One component so the two layouts cannot
 * drift apart.
 *
 * The card link comes first because some pages have no other way back. The
 * store is next: most members arrive from it. It goes through `/store/go`,
 * which signs a member with a connected store account in to the store, and
 * leads to this environment's own storefront (the sandbox, on staging).
 * `/privacy-policy` is the one Google's consent screen links to, so it is
 * reached by people who have never seen the rest of the site and are not
 * signed in; without this they would be left at a dead end.
 */

import type { FC } from "hono/jsx";
import { STORE_GO_PATH } from "./member/storeReturn";

/** The group's own site, linked from the passes (src/passkit/links.ts). */
export const LOS_VERDES_SITE_URL = "https://www.losverdesatx.org";
export const SOURCE_REPOSITORY_URL = "https://github.com/los-verdes/card-losverd-es";

export const SiteFooter: FC = () => (
  <footer class="muted" style="margin-top: 2rem; font-size: 0.85rem">
    <a href="/">Your membership card</a>
    {" · "}
    <a href={STORE_GO_PATH}>Los Verdes store</a>
    {" · "}
    <a href="/privacy-policy">Privacy</a>
    {" · "}
    <a href={SOURCE_REPOSITORY_URL}>Help improve this site on GitHub</a>
  </footer>
);
