/**
 * The two JWTs BigCommerce signs with an app's client secret (#38):
 *
 * - `current.jwt`, which storefront JavaScript fetches from
 *   `/customer/current.jwt?app_client_id=…` and which names the customer
 *   signed in to the store (the Current Customer API), valid about 15 minutes;
 * - `signed_payload_jwt`, which the store sends to an app's load and
 *   uninstall callbacks, naming the store and the control-panel user.
 *
 * Both are HS256 only, addressed to this environment's app (`aud`), and must
 * name this environment's store; anything else is refused. The app's client
 * id and secret (`BIGCOMMERCE_APP_CLIENT_ID`, `BIGCOMMERCE_APP_CLIENT_SECRET`)
 * are one per environment, never the store-level account ingestion uses.
 */

import { errors, jwtVerify } from "jose";
import type { Env } from "../index";

export type AppConfig = { clientId: string; clientSecret: string; storeHash: string };

/** This environment's app, or null until one is configured. */
export function appConfig(env: Env): AppConfig | null {
  const clientId = env.BIGCOMMERCE_APP_CLIENT_ID?.trim();
  const clientSecret = env.BIGCOMMERCE_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, storeHash: env.BIGCOMMERCE_STORE_HASH };
}

/** A storefront or control-panel token that is not one we accept, and why, in a word fit for a log. */
export class AppJwtRejected extends Error {
  constructor(readonly reason: string) {
    super(`BigCommerce JWT rejected: ${reason}`);
  }
}

async function verify(token: string, app: AppConfig) {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(app.clientSecret), {
      algorithms: ["HS256"],
      audience: app.clientId,
    });
    return payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new AppJwtRejected("expired");
    if (err instanceof errors.JWTClaimValidationFailed) throw new AppJwtRejected(`claim:${err.claim}`);
    throw new AppJwtRejected("signature");
  }
}

export interface CurrentCustomer {
  /** The store's customer id; never 0, which is a guest. */
  customerId: number;
  /** When the token expires, epoch seconds: how long a replay record must be kept. */
  expiresAt: number;
}

/** Verifies a storefront `current.jwt`. The email it carries is deliberately not returned: it is never used to match anyone. */
export async function verifyCurrentCustomer(token: string, app: AppConfig): Promise<CurrentCustomer> {
  const payload = await verify(token, app);
  if (payload.operation !== "current_customer") throw new AppJwtRejected("operation");
  if (payload.store_hash !== app.storeHash) throw new AppJwtRejected("store");
  const customer = payload.customer as { id?: unknown } | undefined;
  const customerId = Number(customer?.id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw new AppJwtRejected("customer");
  if (typeof payload.exp !== "number") throw new AppJwtRejected("claim:exp");
  return { customerId, expiresAt: payload.exp };
}

/** Verifies a load or uninstall callback's `signed_payload_jwt`, returning the control-panel user's id. */
export async function verifySignedPayload(token: string, app: AppConfig): Promise<{ userId: number | null }> {
  const payload = await verify(token, app);
  if (payload.sub !== `stores/${app.storeHash}`) throw new AppJwtRejected("store");
  const user = payload.user as { id?: unknown } | undefined;
  const userId = Number(user?.id);
  return { userId: Number.isInteger(userId) ? userId : null };
}
