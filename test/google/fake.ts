import { GOOGLE_OAUTH_TOKEN_URL, GOOGLE_WALLET_API } from "../../src/google/api";

/**
 * Handles the two Google calls a save link now makes (token exchange, then
 * object insert), for specs that fake `fetch` themselves. Anything else
 * fails the test, so a spec's own upstreams go before this in its handler.
 */
export function fakeGoogleWallet(url: string): Response {
  if (url === GOOGLE_OAUTH_TOKEN_URL) {
    return Response.json({ access_token: "fake-wallet-token" });
  }
  if (url.startsWith(`${GOOGLE_WALLET_API}/genericObject`)) {
    return Response.json({});
  }
  throw new Error(`unexpected fetch: ${url}`);
}
