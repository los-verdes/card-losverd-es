import { Hono } from "hono";
import type { Env } from "../index";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import { enqueueEtlSync } from "../queues/etlSync";
import { signWebhookToken } from "./webhookToken";

interface BigCommerceWebhookPayload {
  data: { type: string; id?: number | string };
  hash: string;
  producer: string;
  scope: string;
  store_id: string | number;
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

/**
 * BigCommerce order ids are positive integers. Checking that here keeps an id
 * from a webhook body out of the API path it is interpolated into -- a URL
 * normalises `..` away rather than rejecting it, so an id containing dot
 * segments would address a different endpoint with this store's token
 * attached. Exploiting that needs the webhook token, so this is a second
 * lock rather than the only one; the call sites encode the id as well.
 *
 * It also fails the obvious way round: a malformed id is answered now,
 * instead of becoming a queue message that retries five times and
 * dead-letters.
 */
export function isValidOrderId(id: unknown): boolean {
  return (
    (typeof id === "number" || typeof id === "string") &&
    /^[1-9][0-9]{0,17}$/.test(String(id))
  );
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
    if (!isValidOrderId(payload.data.id)) {
      console.warn("bigcommerce order-webhook: refusing an order id that isn't one");
      return c.text("Bad Request: data.id is not an order id", 400);
    }
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
