/**
 * Cloudflare Web Analytics' page beacon, for the shape of traffic: which
 * pages are visited, from where, on what browser and device, and how fast
 * they load.
 *
 * Cloudflare describes it as collecting no personal data and not tracking
 * visitors across sites; it sets no cookie, so it needs no consent banner.
 * It sees page loads only -- what the Worker decided for each visitor is
 * recorded separately (src/lib/outcome.ts).
 *
 * The site token is public -- it is in every page's source -- so it is a
 * plain var per environment, `WEB_ANALYTICS_TOKEN`. Empty renders nothing.
 * Read through the request context, like the admin nav's counts, because
 * the page shell is rendered from dozens of places that have no `env`.
 *
 * Member-facing pages only. Admin pages are a handful of people clicking
 * around, and counting them would drown the traffic this is for.
 */

import { tryGetContext } from "hono/context-storage";
import type { FC } from "hono/jsx";
import type { Env } from "../index";

export const WEB_ANALYTICS_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

export const WebAnalyticsBeacon: FC = () => {
  const token = tryGetContext<{ Bindings: Env }>()?.env.WEB_ANALYTICS_TOKEN?.trim();
  if (!token) return null;
  return (
    <script defer src={WEB_ANALYTICS_BEACON_SRC} data-cf-beacon={JSON.stringify({ token })}></script>
  );
};
