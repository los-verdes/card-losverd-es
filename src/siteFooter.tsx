/**
 * The line at the foot of every page, member and admin alike: the way back to
 * this site's own front door, the group's site, the privacy policy, and an
 * invitation to help with this one. One component so the two layouts cannot
 * drift apart.
 *
 * The card link comes first because some pages have no other way back.
 * `/privacy-policy` is the one Google's consent screen links to, so it is
 * reached by people who have never seen the rest of the site and are not
 * signed in; without this they would be left at a dead end.
 */

import type { FC } from "hono/jsx";

export const LOS_VERDES_SITE_URL = "https://www.losverdesatx.org";
export const SOURCE_REPOSITORY_URL = "https://github.com/los-verdes/card-losverd-es";

export const SiteFooter: FC = () => (
  <footer class="muted" style="margin-top: 2rem; font-size: 0.85rem">
    <a href="/">Your membership card</a>
    {" · "}
    <a href={LOS_VERDES_SITE_URL}>Los Verdes</a>
    {" · "}
    <a href="/privacy-policy">Privacy</a>
    {" · "}
    <a href={SOURCE_REPOSITORY_URL}>Help improve this site on GitHub</a>
  </footer>
);
