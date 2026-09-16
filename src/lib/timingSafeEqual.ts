/**
 * Constant-time string comparison, for comparing secrets (tokens, HMAC
 * signatures) supplied by an untrusted caller against an expected value --
 * guards against a timing side-channel that a naive `===` compare doesn't.
 * Shared by BigCommerce's webhook auth (`src/bigcommerce/routes.ts`) and
 * PassKit's device-token auth (`src/middleware/auth.ts`), which both need
 * exactly this.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
