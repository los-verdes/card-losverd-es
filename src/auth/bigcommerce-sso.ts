/**
 * BigCommerce storefront "current customer" JWT handoff (the migration
 * plan's Phase 2.3.3). The storefront obtains a short-lived JWT for the
 * logged-in customer (`/customer/current.jwt?app_client_id=...`) and links
 * to `/storefront/:storeHash/members/:jwt/login`, signed with the app's
 * client secret.
 *
 * Ported from the legacy `decode_member_jwt`, but stricter where that code
 * was accidentally loose: HS256 only (legacy also accepted RS256 alongside
 * the symmetric key), the issuer is actually checked (legacy passed
 * `iss="cats"`, which PyJWT silently ignores), and the store hash in the
 * URL must match both the token and this deployment's configured store.
 */

import { jwtVerify } from "jose";
import type { Env } from "../index";

const BIGCOMMERCE_JWT_ISSUER = "bc/apps";
const CURRENT_CUSTOMER_OPERATION = "current_customer";

export interface StorefrontCustomer {
  bigcommerceId: number;
  email: string;
}

/**
 * Returns the customer a storefront JWT vouches for, or `null` if the token
 * is invalid, expired, for another app/store, or malformed.
 */
export async function verifyStorefrontCustomerJwt(
  env: Env,
  storeHash: string,
  token: string,
): Promise<StorefrontCustomer | null> {
  if (!env.BIGCOMMERCE_CLIENT_SECRET) {
    throw new Error("BIGCOMMERCE_CLIENT_SECRET is not configured");
  }
  if (storeHash !== env.BIGCOMMERCE_STORE_HASH) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.BIGCOMMERCE_CLIENT_SECRET),
      {
        algorithms: ["HS256"],
        audience: env.BIGCOMMERCE_CLIENT_ID,
        issuer: BIGCOMMERCE_JWT_ISSUER,
      },
    );
    const customer = payload.customer as
      { id?: unknown; email?: unknown } | undefined;
    if (
      payload.store_hash !== storeHash ||
      payload.operation !== CURRENT_CUSTOMER_OPERATION ||
      typeof customer?.id !== "number" ||
      typeof customer.email !== "string" ||
      customer.email === ""
    ) {
      return null;
    }
    return { bigcommerceId: customer.id, email: customer.email.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Finds or creates the `users` row for a storefront customer, keyed by
 * email (mirrors the legacy `ensure_user`), recording their BigCommerce
 * customer id.
 */
export async function upsertUserFromStorefrontCustomer(
  env: Env,
  customer: StorefrontCustomer,
): Promise<{ id: number; is_admin: number }> {
  const user = await env.DB.prepare(
    `INSERT INTO users (email, bigcommerce_id) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET
       bigcommerce_id = excluded.bigcommerce_id,
       updated_at = (unixepoch('subsec') * 1000)
     RETURNING id, is_admin`,
  )
    .bind(customer.email, customer.bigcommerceId)
    .first<{ id: number; is_admin: number }>();
  return user!;
}
