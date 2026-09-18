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

import type { GenericObject, GoogleWalletCredentials } from "./jwt";
import { fetchServiceAccountToken } from "./serviceAccountToken";

// Re-exported because callers and tests have always reached for it here, and
// because it reads oddly to import a URL from one module and the function
// that posts to it from another.
export { GOOGLE_OAUTH_TOKEN_URL } from "./serviceAccountToken";

export const GOOGLE_WALLET_API =
  "https://walletobjects.googleapis.com/walletobjects/v1";

/** Google issues hour-long tokens; reuse one for most of that within an isolate. */
const TOKEN_MAX_AGE_SECONDS = 50 * 60;

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
  const token = await fetchServiceAccountToken(
    credentials.serviceAccountEmail,
    credentials.privateKeyPem,
    nowSeconds,
  );
  cachedToken = {
    serviceAccountEmail: credentials.serviceAccountEmail,
    token,
    issuedAt: nowSeconds,
  };
  return token;
}

/**
 * Updates an object Google already has, and does nothing if it has none.
 *
 * The distinction from `upsertGenericObject` matters: this runs from the
 * order sync, once per member whose pass-visible details changed, so a
 * backfill or a full resync passes through it for every member at once.
 * Inserting there would mint a Wallet object for every member on the roll,
 * including everyone who has never asked for one -- the same class of bulk
 * side effect the card emails are guarded against. A member who has never
 * saved a pass has nothing to refresh, and the save link creates the object
 * when they do.
 */
export async function updateGenericObjectIfPresent(
  credentials: GoogleWalletCredentials,
  object: GenericObject,
): Promise<"updated" | "absent"> {
  const token = await getGoogleWalletAccessToken(credentials);
  const res = await fetch(
    `${GOOGLE_WALLET_API}/genericObject/${encodeURIComponent(object.id)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(object),
    },
  );
  if (res.ok) return "updated";
  if (res.status === 404) {
    await res.body?.cancel();
    return "absent";
  }
  throw new Error(
    `Google Wallet object update failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
  );
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
