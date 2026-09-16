/**
 * PassKit device-token authorization (Phase 4.1/4.3/4.4 of
 * `.ai/gcp-to-cf_plan.md`): Apple devices authenticate to the web service
 * with `Authorization: ApplePass <authenticationToken>`, where the token is
 * the one baked into the member's `pass.json` at issuance
 * (`members.auth_token`). This file is also where Phase 2.3.4's
 * `requireAuth`/`requireAdmin`/`requireActiveMembership` member-session
 * middleware will eventually live (per Phase 2.3.8 of the plan) -- unrelated
 * concerns sharing one file by convention (all "authorization middleware"),
 * not by any shared code, so don't be surprised this file is PassKit-only
 * for now.
 */

import { timingSafeEqual } from "../lib/timingSafeEqual";

const AUTH_SCHEME_PREFIX = "ApplePass ";

/**
 * Verifies the incoming `Authorization: ApplePass <token>` header against a
 * member's stored `auth_token`. Apple's own examples use this exact,
 * case-sensitive scheme prefix (unlike BigCommerce's webhook auth, which
 * ported a legacy case-insensitive comparison from the Python app -- there's
 * no equivalent legacy PassKit implementation to match here).
 */
export function verifyPassAuthorization(
  authorizationHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith(AUTH_SCHEME_PREFIX)) return false;
  return timingSafeEqual(
    authorizationHeader.slice(AUTH_SCHEME_PREFIX.length),
    expectedToken,
  );
}
