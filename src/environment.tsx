/**
 * Which environment a page comes from, said on the page (#338).
 *
 * Staging and production otherwise look identical, so a change meant as a
 * test on staging could be made on production by mistake -- most easily from
 * the admin pages, with both sites open in tabs. Staging therefore carries a
 * banner on every page, a "[Staging]" prefix on every title and a favicon of
 * its own, and production's admin nav says "Production" outright rather than
 * relying on somebody noticing that the banner is missing.
 *
 * Only exactly "production" is production. Anything else, including a
 * missing or misspelled `ENVIRONMENT`, is shown as not production.
 *
 * Read through the request context, like the Web Analytics beacon, because
 * the page shells are rendered from dozens of places that have no `env`.
 * Rendered outside a request there is nothing to go on, and nothing is shown.
 */

import { tryGetContext } from "hono/context-storage";
import type { FC } from "hono/jsx";
import type { Env } from "./index";

export type SiteEnvironment = "production" | "staging" | "unknown";

export function siteEnvironment(value: string | undefined): SiteEnvironment {
  if (value === "production") return "production";
  if (value === "staging") return "staging";
  return "unknown";
}

/** The environment of the request being rendered, or null outside a request. */
export function currentSiteEnvironment(): SiteEnvironment | null {
  const env = tryGetContext<{ Bindings: Env }>()?.env;
  return env ? siteEnvironment(env.ENVIRONMENT) : null;
}

/** What starts a page title: "[Staging] " on staging, nothing on production. */
export function titlePrefix(): string {
  const environment = currentSiteEnvironment();
  if (environment === "staging") return "[Staging] ";
  if (environment === "unknown") return "[Unknown environment] ";
  return "";
}

export const STAGING_BANNER_TEXT = "Staging: test store and test data. Nothing here touches real memberships.";
export const UNKNOWN_ENVIRONMENT_BANNER_TEXT =
  "Unknown environment: this site does not say it is production, so treat it as a test.";

/** A full-width strip across the top of every page that is not production. */
export const EnvironmentBanner: FC = () => {
  const environment = currentSiteEnvironment();
  if (environment === null || environment === "production") return null;
  return (
    <div class="env-banner" role="note">
      {environment === "staging" ? STAGING_BANNER_TEXT : UNKNOWN_ENVIRONMENT_BANNER_TEXT}
    </div>
  );
};

/** "Production", in the admin nav on the live site. Members never see the admin nav. */
export const ProductionLabel: FC = () =>
  currentSiteEnvironment() === "production" ? <span class="env-label">Production</span> : null;
