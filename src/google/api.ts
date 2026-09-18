/**
 * The little of the Google Wallet REST API this Worker uses: getting a
 * service-account access token, and inserting or updating one
 * `GenericObject`.
 *
 * Why the Worker writes objects at all: a save link that carries the whole
 * object is over Google's 1,800-character safe length for this project's
 * passes (a signed /verify-pass URL in the QR code is most of it), and a
 * link that long can be truncated by a browser -- which surfaces as the
 * generic "Something went wrong" (#96). So the object is written here first,
 * and the save link carries only its id (Google's "skinny" JWT). A side
 * effect is that every time a save link is built, Google's copy of the pass
 * is brought up to date.
 *
 * Plain `fetch` against the REST endpoints, like the rest of this codebase;
 * `scripts/google-wallet-check.ts` does the same from Node.
 */

import { SignJWT, importPKCS8 } from "jose";
import type { GenericObject, GoogleWalletCredentials } from "./jwt";

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_WALLET_API =
  "https://walletobjects.googleapis.com/walletobjects/v1";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

/** Google issues hour-long tokens; reuse one for most of that within an isolate. */
const TOKEN_MAX_AGE_SECONDS = 50 * 60;
const ASSERTION_LIFETIME_SECONDS = 5 * 60;

let cachedToken: {
  serviceAccountEmail: string;
  token: string;
  issuedAt: number;
} | null = null;

/** Test hook: forget the cached access token. */
export function resetGoogleWalletTokenCache(): void {
  cachedToken = null;
}

/**
 * An OAuth access token for the service account, via the JWT-bearer grant
 * (the same exchange `scripts/google-wallet-check.ts` does). Cached per
 * isolate; a new one is fetched when the credentials change or the cache
 * ages out.
 */
export async function getGoogleWalletAccessToken(
  credentials: GoogleWalletCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (
    cachedToken?.serviceAccountEmail === credentials.serviceAccountEmail &&
    nowSeconds - cachedToken.issuedAt < TOKEN_MAX_AGE_SECONDS
  ) {
    return cachedToken.token;
  }
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(credentials.serviceAccountEmail)
    .setAudience(GOOGLE_OAUTH_TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ASSERTION_LIFETIME_SECONDS)
    .sign(await importPKCS8(credentials.privateKeyPem, "RS256"));
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
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
  const body = await res.json<{ access_token?: string }>();
  if (!body.access_token) {
    throw new Error("Google Wallet token exchange returned no access_token");
  }
  cachedToken = {
    serviceAccountEmail: credentials.serviceAccountEmail,
    token: body.access_token,
    issuedAt: nowSeconds,
  };
  return body.access_token;
}

/**
 * Writes `object` to Google: an insert, or -- once it exists, which the API
 * reports as 409 -- a full update, so a changed name or expiry lands on the
 * pass the member already saved. Returns which happened.
 */
export async function upsertGenericObject(
  credentials: GoogleWalletCredentials,
  object: GenericObject,
): Promise<"inserted" | "updated"> {
  const token = await getGoogleWalletAccessToken(credentials);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const inserted = await fetch(`${GOOGLE_WALLET_API}/genericObject`, {
    method: "POST",
    headers,
    body: JSON.stringify(object),
  });
  if (inserted.ok) return "inserted";
  if (inserted.status !== 409) {
    throw new Error(
      `Google Wallet object insert failed: ${inserted.status} ${(await inserted.text()).slice(0, 300)}`,
    );
  }
  await inserted.body?.cancel();
  const updated = await fetch(
    `${GOOGLE_WALLET_API}/genericObject/${encodeURIComponent(object.id)}`,
    { method: "PUT", headers, body: JSON.stringify(object) },
  );
  if (!updated.ok) {
    throw new Error(
      `Google Wallet object update failed: ${updated.status} ${(await updated.text()).slice(0, 300)}`,
    );
  }
  return "updated";
}
