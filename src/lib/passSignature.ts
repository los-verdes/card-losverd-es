/**
 * Membership card QR-code signatures (`/verify-pass/:serial?signature=`),
 * byte-compatible with the legacy app's `member_card/utils.sign()` so QR codes
 * already in the world keep verifying (docs/legacy-pass-compatibility.md, D2):
 * `urlsafe_b64encode(HMAC-SHA256(key, serial))` -- URL-safe alphabet *with*
 * `=` padding, which differs from Node's `base64url` digest.
 *
 * `PASS_SIGNATURE_KEY` holds the exact legacy key bytes (the legacy app used
 * `SECRET_KEY * 5`), so that quirk lives in the one-time secret setup rather
 * than in code. Rotation is tracked in issue #27.
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

export async function verifyPassSerialSignature(
  key: string,
  serial: string,
  signature: string | undefined,
): Promise<boolean> {
  const expected = await signPassSerial(key, serial);
  return signature !== undefined && timingSafeEqual(expected, signature);
}
