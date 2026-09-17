/**
 * Standard (padded, non-URL-safe) base64 of raw bytes.
 *
 * Chunked because `String.fromCharCode(...bytes)` overflows the call stack
 * for image- and attachment-sized arrays.
 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
