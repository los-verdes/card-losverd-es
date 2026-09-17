import { Hono } from "hono";
import type { Env } from "../index";
import { bytesToBase64 } from "../lib/base64";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import { enqueueEtlSync } from "../queues/etlSync";

interface BigCommerceWebhookPayload {
  data: { type: string; id?: number | string };
  hash: string;
  producer: string;
  scope: string;
  store_id: string | number;
}

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
  return bytesToBase64(signature);
}

/**
 * Verifies the incoming `Authorization: bearer <token>` header (case-
 * insensitive on both the scheme and the token itself, matching the Python
 * app's `.lower()` handling) against the expected signed token.
 */
export function verifyWebhookAuthorization(
  authorizationHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader) return false;
  const incoming = authorizationHeader
    .toLowerCase()
    .replace("bearer", "")
    .trim();
  return timingSafeEqual(incoming, expectedToken.toLowerCase());
}

const bigcommerce = new Hono<{ Bindings: Env }>();

/**
 * BigCommerce order webhook receiver. Validates fast and enqueues, per
 * the migration plan's Phase 2.5.5 - no order sync work happens
 * inline in this request. Mirrors
 * `member_card/routes/bigcommerce.py::order_webhook()`.
 */
bigcommerce.post("/order-webhook", async (c) => {
  let payload: BigCommerceWebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.text("Bad Request: invalid JSON body", 400);
  }

  if (
    !payload?.data?.type ||
    !payload.producer ||
    payload.store_id === undefined
  ) {
    return c.text("Bad Request: missing required webhook fields", 400);
  }

  const storeHash = payload.producer.split("/")[1];
  const configuredStoreHash = c.env.BIGCOMMERCE_STORE_HASH;
  if (storeHash !== configuredStoreHash) {
    console.warn(
      `bigcommerce order-webhook: refusing payload for store_hash=${storeHash} (not configured store ${configuredStoreHash})`,
    );
    return c.text(
      `Refusing to process webhook payload for store_hash=${storeHash}`,
      403,
    );
  }

  const expectedToken = await signWebhookToken(
    c.env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY,
    configuredStoreHash,
    c.env.BIGCOMMERCE_CLIENT_ID,
  );
  const authorized = verifyWebhookAuthorization(
    c.req.header("authorization"),
    expectedToken,
  );
  if (!authorized) {
    console.warn(
      "bigcommerce order-webhook: unable to verify webhook signature",
    );
    return c.text("Unauthorized: unable to verify webhook signature", 401);
  }

  if (payload.data.type === "order" && payload.data.id !== undefined) {
    await enqueueEtlSync(c.env, {
      type: "sync_bigcommerce_order",
      orderId: String(payload.data.id),
      storeHash,
    });
  } else {
    console.warn(
      `bigcommerce order-webhook: no handler for data.type=${payload.data.type}`,
    );
  }

  return c.text("Got it, thanks! :)");
});

export default bigcommerce;
