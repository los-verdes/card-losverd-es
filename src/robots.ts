/**
 * `/robots.txt`, which crawlers ask for before anything else and which was
 * otherwise a 404 on every visit.
 *
 * Almost nothing here is worth a search result: cards and admin pages sit
 * behind a sign-in, and a `/verify-pass` link carries a real card's
 * signature. Production leaves open the sign-in page people search for
 * (signed out, `/` redirects to `/login`), the privacy policy, and
 * `/assets/`, whose crest Google Wallet fetches by URL for every pass
 * (src/assets.ts) -- shutting that out risks the logo on members' passes
 * for no gain. Anything other than production, staging
 * included, asks crawlers to stay out entirely.
 *
 * This only asks politely. Admin pages also say `noindex`, verify-pass sends
 * `X-Robots-Tag: noindex`, and what actually protects a page is its sign-in.
 */

import { Hono } from "hono";
import { siteEnvironment } from "./environment";
import type { Env } from "./index";
import { PRIVACY_PATH } from "./member/privacy";

export const PRODUCTION_ROBOTS_TXT = [
  "User-agent: *",
  "Allow: /$",
  "Allow: /login$",
  `Allow: ${PRIVACY_PATH}`,
  "Allow: /assets/",
  "Disallow: /",
  "",
].join("\n");

export const CLOSED_ROBOTS_TXT = ["User-agent: *", "Disallow: /", ""].join("\n");

const robots = new Hono<{ Bindings: Env }>();

robots.get("/", (c) => {
  const body =
    siteEnvironment(c.env.ENVIRONMENT) === "production" ? PRODUCTION_ROBOTS_TXT : CLOSED_ROBOTS_TXT;
  c.header("Cache-Control", "public, max-age=86400");
  return c.text(body);
});

export default robots;
