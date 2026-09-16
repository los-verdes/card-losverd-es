/**
 * APNs client for Apple Wallet pass-update pushes (the migration plan's Phase
 * 4.7), using token-based auth: an ES256 JWT signed with an APNs auth key
 * (`.p8`) from the Apple Developer portal.
 *
 * Wallet pass pushes are content-free: an empty `{}` payload on the pass
 * type identifier's topic tells Wallet to call the web service back for
 * changed serials. No `apns-push-type` header is sent -- Wallet
 * implementations commonly omit it, and setting one has been reported to
 * produce `InvalidPushType` for pass topics. Apple only delivers pass
 * updates from the production APNs environment.
 *
 * Only testable against a real device: production Workers reach APNs over
 * HTTP/2, but local workerd (`wrangler dev`, vitest) can't
 * (cloudflare/workerd#4841), so tests here mock `fetch`.
 */

import { SignJWT, importPKCS8 } from "jose";

export const APNS_ORIGIN = "https://api.push.apple.com";

// Apple rejects provider tokens older than an hour, and throttles refreshing
// them more often than every 20 minutes (TooManyProviderTokenUpdates).
const PROVIDER_TOKEN_MAX_AGE_SECONDS = 40 * 60;

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  /** The pass type identifier, e.g. `pass.es.losverd.card`. */
  topic: string;
}

export type PushResult =
  | { status: "sent" }
  /** The device token is no longer valid for this topic; stop pushing to it. */
  | { status: "unregistered"; reason: string }
  | { status: "failed"; httpStatus: number; reason: string };

let cachedToken: { keyId: string; token: string; issuedAt: number } | null =
  null;

/** Test hook; also used internally when APNs says the token went bad. */
export function resetProviderTokenCache(): void {
  cachedToken = null;
}

export async function getProviderToken(
  config: ApnsConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (
    cachedToken?.keyId === config.keyId &&
    nowSeconds - cachedToken.issuedAt < PROVIDER_TOKEN_MAX_AGE_SECONDS
  ) {
    return cachedToken.token;
  }
  const key = await importPKCS8(config.privateKeyPem, "ES256");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(nowSeconds)
    .sign(key);
  cachedToken = { keyId: config.keyId, token, issuedAt: nowSeconds };
  return token;
}

async function readReason(res: Response): Promise<string> {
  try {
    const body = await res.json<{ reason?: unknown }>();
    return typeof body.reason === "string" ? body.reason : "";
  } catch {
    return "";
  }
}

export async function sendPassUpdatePush(
  config: ApnsConfig,
  pushToken: string,
): Promise<PushResult> {
  const res = await fetch(
    `${APNS_ORIGIN}/3/device/${encodeURIComponent(pushToken)}`,
    {
      method: "POST",
      headers: {
        authorization: `bearer ${await getProviderToken(config)}`,
        "apns-topic": config.topic,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  if (res.status === 200) {
    return { status: "sent" };
  }

  const reason = await readReason(res);
  if (
    res.status === 410 ||
    (res.status === 400 && reason === "BadDeviceToken")
  ) {
    return { status: "unregistered", reason: reason || "Unregistered" };
  }
  if (
    res.status === 403 &&
    (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")
  ) {
    resetProviderTokenCache();
  }
  return { status: "failed", httpStatus: res.status, reason };
}
