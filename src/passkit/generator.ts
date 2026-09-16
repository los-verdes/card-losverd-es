import { zipSync } from "fflate";
import { signManifestDetached, type PassSigningCredentials } from "./signer";

/** The subset of a `members` row (Phase 2.1) needed to build a pass. */
export interface MemberPassInput {
  memberId: string; // == the pass's serialNumber
  firstName: string;
  lastName: string;
  membershipTier: string;
  status: "active" | "expired" | "revoked";
  expirationDate: string | null; // ISO8601 date (YYYY-MM-DD), or null if unset
  authToken: string;
}

/** Static, non-secret PassKit identifiers -- one set per deployment environment. */
export interface PassKitConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  /** Apple polls this for registration/update checks -- see Phase 4.1/4.2. */
  webServiceURL: string;
}

/**
 * Non-`pass.json` bundle files -- icon/logo/strip images per Apple's pass
 * asset conventions. Sourced from R2 (Phase 3.1's `templates/apple/`
 * layout) by the caller (the eventual `src/passkit/routes.ts`), not fetched
 * here -- keeps this module pure/testable without an R2 fixture per test.
 */
export type PassAssetFiles = Record<string, Uint8Array>;

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds `manifest.json`: `{ filename: sha1Hex }` for every file in the bundle, per Phase 4.6. */
export async function buildManifest(
  files: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const manifest: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    manifest[name] = await sha1Hex(bytes);
  }
  return new TextEncoder().encode(JSON.stringify(manifest));
}

// TODO(human): Implement buildPassJson -- the actual `pass.json` content for
// a real Los Verdes membership pass (see Apple's PassKit Package Format
// Reference for the full field vocabulary). This is a product/design
// decision, not a technical one, so it's yours rather than something to
// invent unilaterally.
//
// Must return UTF-8-encoded JSON bytes for a `generic` pass (no boarding
// pass/coupon/event ticket structure needed) with at least:
//   - formatVersion: 1
//   - passTypeIdentifier, teamIdentifier, organizationName, webServiceURL
//     (from `config`)
//   - serialNumber: member.memberId
//   - authenticationToken: member.authToken (Apple's device-registration
//     auth scheme, see Phase 4.1)
//   - description (required by Apple; shown to VoiceOver users)
//   - some `generic.primaryFields`/`secondaryFields`/`auxiliaryFields`
//     layout showing at minimum the member's name and membership tier --
//     consider also surfacing `status`/`expirationDate` (e.g. greyed out or
//     a backFields note when status is "expired"/"revoked")
//   - a `barcode` (format "PKBarcodeFormatQR" is a reasonable default;
//     `message` is typically the serialNumber so `/verify-pass/<serial>`-style
//     lookups keep working)
//
// Colors (`backgroundColor`/`foregroundColor`/`labelColor`) and
// `backFields` are up to you too -- there's no existing Jinja pass template
// to port from 1:1 since this is a from-scratch TypeScript pass, unlike the
// card-image side (Phase 1.0.2) which re-authored an existing design.
function buildPassJson(
  member: MemberPassInput,
  config: PassKitConfig,
): Uint8Array {
  throw new Error("not implemented");
}

/**
 * Assembles and signs a complete `.pkpass` bundle (pass.json + manifest.json
 * + signature + asset files, zipped) per Phase 4.3/4.6. Pure function of its
 * inputs -- no R2/D1 I/O -- so the eventual HTTP route only has to handle
 * fetching those inputs and caching/streaming the result.
 */
export async function assemblePassBundle(
  member: MemberPassInput,
  config: PassKitConfig,
  assets: PassAssetFiles,
  credentials: PassSigningCredentials,
): Promise<Uint8Array> {
  const passJsonBytes = buildPassJson(member, config);
  const files: Record<string, Uint8Array> = {
    "pass.json": passJsonBytes,
    ...assets,
  };

  const manifestBytes = await buildManifest(files);
  const signatureDer = signManifestDetached(manifestBytes, credentials);

  return zipSync({
    ...files,
    "manifest.json": manifestBytes,
    signature: signatureDer,
  });
}

function cacheKey(passTypeIdentifier: string, serialNumber: string): string {
  return `cache/pkpass/${passTypeIdentifier}/${serialNumber}.pkpass`;
}

/** Reads a previously-generated `.pkpass` from R2's Phase 3.3 cache, or `null` on a miss. */
export async function getCachedPass(
  bucket: R2Bucket,
  passTypeIdentifier: string,
  serialNumber: string,
): Promise<Uint8Array | null> {
  const object = await bucket.get(cacheKey(passTypeIdentifier, serialNumber));
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/** Writes a generated `.pkpass` to R2's Phase 3.3 cache. */
export async function putCachedPass(
  bucket: R2Bucket,
  passTypeIdentifier: string,
  serialNumber: string,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(cacheKey(passTypeIdentifier, serialNumber), bytes, {
    httpMetadata: { contentType: "application/vnd.apple.pkpass" },
  });
}

/**
 * Invalidates a member's cached `.pkpass` (Phase 3.3: "When a member record
 * is modified ... delete or overwrite the corresponding R2 cache key").
 * Deleting rather than immediately regenerating keeps this cheap to call
 * from any write path (e.g. the BigCommerce sync) -- the next `GET
 * /v1/passes/...` request regenerates on the resulting cache miss.
 */
export async function invalidateCachedPass(
  bucket: R2Bucket,
  passTypeIdentifier: string,
  serialNumber: string,
): Promise<void> {
  await bucket.delete(cacheKey(passTypeIdentifier, serialNumber));
}
