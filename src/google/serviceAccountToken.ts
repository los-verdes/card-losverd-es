/**
 * Exchanging a Google service-account key for an access token, via the
 * JWT-bearer grant: sign a short-lived assertion with the account's private
 * key, hand it to Google, get a token back.
 *
 * This existed in three places -- the Worker's `api.ts`, and both
 * `scripts/google-wallet-*` tools -- which is three chances for the scope,
 * the audience or the assertion lifetime to drift apart, on the one routine
 * where being subtly wrong looks like "Google says no" rather than like a
 * bug. They agreed when this was written; the point is that they no longer
 * have to be kept agreeing.
 *
 * Deliberately import-free apart from `jose`, on the same terms as
 * `src/bigcommerce/webhookToken.ts`. The Worker imports it normally, and the
 * `.mjs` tools in `scripts/` import it directly under Node's TypeScript type
 * stripping -- which resolves package imports fine but cannot follow this
 * repository's extensionless relative ones. Keeping this module's imports to
 * packages is what lets one copy serve both.
 */

import { SignJWT, importPKCS8 } from "jose";

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Issuing and updating Wallet objects; the only scope this project needs. */
export const GOOGLE_WALLET_SCOPE =
  "https://www.googleapis.com/auth/wallet_object.issuer";

/**
 * Google allows up to an hour, but the assertion is used immediately and
 * discarded, so a short life limits what a leaked one is worth.
 */
const ASSERTION_LIFETIME_SECONDS = 5 * 60;

/**
 * A fresh access token. No caching here deliberately: a command-line tool
 * wants one token and exits, while the Worker reuses one across requests, so
 * the cache belongs with the caller that benefits from it (`api.ts`).
 *
 * `tokenUrl` is overridable only so the scripts can be pointed at a local
 * stand-in; nothing in the Worker passes it.
 */
export async function fetchServiceAccountToken(
  serviceAccountEmail: string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  tokenUrl: string = GOOGLE_OAUTH_TOKEN_URL,
): Promise<string> {
  const assertion = await new SignJWT({ scope: GOOGLE_WALLET_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccountEmail)
    .setAudience(tokenUrl)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ASSERTION_LIFETIME_SECONDS)
    .sign(await importPKCS8(privateKeyPem, "RS256"));

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google Wallet token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Google Wallet token exchange returned no access_token");
  }
  return body.access_token;
}
