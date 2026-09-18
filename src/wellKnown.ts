/**
 * Apple's domain-association file, for verifying a host with Sign in with
 * Apple (los-verdes/card-losverd-es#108).
 *
 * Sign in with Apple on the web only works from hosts registered against the
 * Services ID, and Apple will not accept a host until it has proved we
 * control it: it fetches
 * `/.well-known/apple-developer-domain-association.txt` and compares the
 * contents with a file generated for that Services ID. Until that succeeds
 * the authorize endpoint answers `invalid_client`, which says nothing about
 * the domain at all.
 *
 * Apple checks once, when the "Verify" button is pressed, and never again --
 * which is why the legacy deployment serves nothing here today despite
 * `card.losverd.es` being a verified host. The file only has to be reachable
 * during verification, but there is no cost to leaving it in place, and
 * leaving it means re-verifying later (a second Services ID, a new hostname)
 * is a config change rather than an archaeology exercise.
 *
 * Apple is strict about how it is served: exactly this path, HTTPS, a 200
 * with no redirects, and `text/plain`. A Worker satisfies all of that as long
 * as the route is registered before anything that could redirect to login.
 *
 * The contents are not secret -- the whole point is that anyone can fetch
 * them -- so this is a plain var per environment rather than a Worker secret.
 */

import { Hono } from "hono";
import type { Env } from "./index";

export const APPLE_DOMAIN_ASSOCIATION_PATH =
  "/.well-known/apple-developer-domain-association.txt";

const wellKnown = new Hono<{ Bindings: Env }>();

wellKnown.get("/apple-developer-domain-association.txt", (c) => {
  const body = c.env.APPLE_DOMAIN_ASSOCIATION?.trim();
  if (!body) {
    // Nothing to verify against is better than an empty 200, which Apple
    // would read as a mismatch rather than as "not set up yet".
    return c.notFound();
  }
  return c.text(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    // Verification is a one-off against whatever is configured right now;
    // a cached copy of a previous environment's file would fail it.
    "Cache-Control": "no-store",
  });
});

export default wellKnown;
