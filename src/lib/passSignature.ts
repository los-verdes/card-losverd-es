/**
 * Membership card QR-code signatures (`/verify-pass/:serial?signature=`),
 * byte-compatible with the legacy app's `member_card/utils.sign()` so QR codes
 * already in the world keep verifying (docs/legacy-pass-compatibility.md, D2):
 * `urlsafe_b64encode(HMAC-SHA256(key, serial))` -- URL-safe alphabet *with*
 * `=` padding, which differs from Node's `base64url` digest.
 *
 * `PASS_SIGNATURE_KEY` holds the exact legacy key bytes (the legacy app used
 * `SECRET_KEY * 5`), so that quirk lives in the one-time secret setup rather
 * than in code.
 *
 * Rotation (#27) works without changing the URL format, which matters because
 * the QR codes already in the world carry no key identifier and never will:
 * new signatures are always made with `PASS_SIGNATURE_KEY`, while
 * `PASS_SIGNATURE_KEY_PREVIOUS`, when set, is *also* accepted at verification
 * time. Two HMACs on the failing path is not a cost worth optimizing. See
 * docs/pass-signature-rotation.md for the operational steps.
 */

import { timingSafeEqual } from "./timingSafeEqual";

function toUrlSafeBase64WithPadding(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

export async function signPassSerial(
  key: string,
  serial: string,
): Promise<string> {
  if (!key) {
    throw new Error("PASS_SIGNATURE_KEY is not configured");
  }
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(serial),
  );
  return toUrlSafeBase64WithPadding(signature);
}

/** The keys `/verify-pass` accepts: the signing key, plus a retired one during a rotation. */
export interface PassSignatureKeys {
  current: string;
  previous?: string;
}

/** Which key a signature verified against, for the rotation logging in src/member/verify-pass.tsx. */
export type PassSignatureKeyUsed = "current" | "previous";

/**
 * Reads both keys from the environment. `PASS_SIGNATURE_KEY_PREVIOUS` is
 * absent outside a rotation, and is ignored when it duplicates the current
 * key, so a copy-paste slip can't quietly make a "rotation" a no-op that
 * still reports old codes as retired.
 */
export function passSignatureKeys(env: {
  PASS_SIGNATURE_KEY: string;
  PASS_SIGNATURE_KEY_PREVIOUS?: string;
}): PassSignatureKeys {
  const previous = env.PASS_SIGNATURE_KEY_PREVIOUS;
  return {
    current: env.PASS_SIGNATURE_KEY,
    ...(previous && previous !== env.PASS_SIGNATURE_KEY ? { previous } : {}),
  };
}

/** Which key verified `signature`, or null if none did. */
export async function verifyPassSerialSignature(
  keys: PassSignatureKeys,
  serial: string,
  signature: string | undefined,
): Promise<PassSignatureKeyUsed | null> {
  if (signature === undefined) {
    return null;
  }
  if (timingSafeEqual(await signPassSerial(keys.current, serial), signature)) {
    return "current";
  }
  if (
    keys.previous &&
    timingSafeEqual(await signPassSerial(keys.previous, serial), signature)
  ) {
    return "previous";
  }
  return null;
}

/**
 * The URL a membership card's QR code encodes: `/verify-pass/:serial` with
 * that serial's signature (src/member/verify-pass.tsx). `baseUrl` is the
 * public origin, e.g. `https://card.losverd.es`.
 */
export async function buildVerifyPassUrl(
  baseUrl: string,
  key: string,
  serial: string,
): Promise<string> {
  const url = new URL(`/verify-pass/${encodeURIComponent(serial)}`, baseUrl);
  url.searchParams.set("signature", await signPassSerial(key, serial));
  return url.toString();
}
