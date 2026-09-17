/**
 * Mirrors `member_card/bigcommerce.py::generate_webhook_token()`: BigCommerce
 * doesn't sign webhook payload bodies with a computable HMAC the way e.g.
 * Shopify does, so the existing app authenticates webhooks via a custom
 * shared-secret bearer token set once at webhook-subscription-creation time
 * (BigCommerce's `headers` field on `Webhooks.create()`), and re-derives the
 * same value on receipt to compare against. See
 * docs/bigcommerce-ingestion.md section 1 for the full rationale, including
 * why this uses a new dedicated `BIGCOMMERCE_WEBHOOK_SIGNING_KEY` secret
 * rather than reusing another secret the way the old app's single
 * `SECRET_KEY` did.
 *
 * Deliberately import-free: the Worker (src/bigcommerce/routes.ts) verifies
 * with it, and scripts/bigcommerce-webhook.mjs registers webhooks with it,
 * importing this file directly under Node's TypeScript type stripping -- so
 * the token a webhook is registered with can't drift from the one checked.
 */
export async function signWebhookToken(
  signingKey: string,
  storeHash: string,
  clientId: string,
): Promise<string> {
  // Fail closed: an HMAC over an empty key is just as forgeable as one over a
  // publicly known placeholder.
  if (!signingKey) {
    throw new Error("BIGCOMMERCE_WEBHOOK_SIGNING_KEY is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${storeHash}.${clientId}`),
  );
  // A 32-byte HMAC is small enough to spread straight into fromCharCode.
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
