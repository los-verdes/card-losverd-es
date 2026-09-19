import { zipSync } from "fflate";
import { formatMonthYear, formatShortDate } from "../lib/dateFormat";
import { signManifestDetached, type PassSigningCredentials } from "./signer";

/** The subset of a `members` row (Phase 2.1) needed to build a pass. */
export interface MemberPassInput {
  memberId: string; // == the pass's serialNumber
  firstName: string;
  lastName: string;
  membershipTier: string;
  status: "active" | "expired" | "revoked";
  expirationDate: string | null; // ISO8601 date (YYYY-MM-DD), or null if unset
  /** ISO8601 date (YYYY-MM-DD), or null if not yet known/backfilled (Phase 2.2). */
  memberSince: string | null;
  authToken: string;
  /** Signed `/verify-pass` URL encoded in the QR code (`buildVerifyPassUrl`). */
  verifyUrl: string;
}

/** Static, non-secret PassKit identifiers -- one set per deployment environment. */
export interface PassKitConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  /** Apple polls this for registration/update checks -- see Phase 4.1/4.2. */
  webServiceURL: string;
  /**
   * Which environment issued the pass. Shown on the back only when it isn't
   * production, so a member's own card stays uncluttered while a pass
   * accidentally installed from staging says so on its face -- that pass
   * points at staging's web service and will never be updated by production.
   */
  environment?: string;
}

type PassTextAlignment =
  | "PKTextAlignmentLeft"
  | "PKTextAlignmentCenter"
  | "PKTextAlignmentRight"
  | "PKTextAlignmentNatural";

interface PassField {
  key: string;
  label: string;
  value: string;
  textAlignment: PassTextAlignment;
}

interface PassJson {
  formatVersion: 1;
  passTypeIdentifier: string;
  serialNumber: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
  suppressStripShine: false;
  generic: {
    primaryFields: PassField[];
    secondaryFields: PassField[];
    auxiliaryFields: PassField[];
    backFields: PassField[];
  };
  barcode: {
    format: "PKBarcodeFormatQR";
    message: string;
    messageEncoding: "iso-8859-1";
    altText: string;
  };
  backgroundColor: string;
  foregroundColor: string;
  logoText: string;
  authenticationToken: string;
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
  // Never SharedArrayBuffer-backed; the narrowing satisfies the DOM lib types
  // that @auth/core's preact dependency pulls into the program.
  const digest = await crypto.subtle.digest(
    "SHA-1",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/**
 * Builds `pass.json` content for a real Los Verdes membership pass. Field
 * structure, labels, and date formats (member_since as "Jul 2021",
 * expiration as "Feb 17, 2024") come from a real pass pulled from the
 * legacy production app (`lv_apple_pass-hogan.pkpass`), not invented from
 * the Apple PassKit spec alone.
 *
 * Two things that real example did which this deliberately does NOT
 * replicate, since they look like legacy-app bugs rather than intended
 * behavior: its `organizationName` was set to the Apple Developer Team ID
 * instead of a human-readable name (here it comes from `config` as its own
 * distinct value -- getting that right is the caller's job, not this
 * function's), and its `backgroundColor` was a malformed
 * `"rgb((0, 177, 64)"` string rather than valid `"rgb(0, 177, 64)"`.
 *
 * Like the real example, the QR code encodes a signed `/verify-pass/...` URL
 * -- computed by the caller (it needs `PASS_SIGNATURE_KEY`) and threaded in as
 * `member.verifyUrl`, the same way `authToken` is. Unlike it, there's no
 * legacy `Content: ` prefix on the message.
 */
/**
 * Bump when a change here alters what a pass contains -- a field, a label, a
 * colour, which asset is used, or the rule behind any of them.
 *
 * Generated passes are cached in R2 and only regenerated when the member's
 * own record changes. A member whose details are stable never triggers that,
 * so without this a pass-content change reaches only members who happen to
 * renew or be corrected afterwards, and everyone else keeps being handed the
 * old pass from cache indefinitely. #104 -- which stopped a pass claiming a
 * lapsed membership was active -- is exactly that kind of change.
 *
 * Deliberately not the deploy or commit id: that would discard every cached
 * pass on every deploy, and regenerating one costs a signature. This is the
 * same discipline as a migration number, and the same failure mode if
 * forgotten, which is why it sits here rather than beside the cache.
 *
 * It is also shown on the pass itself -- the bottom of the back of an Apple
 * pass, the last detail of a Google one -- so that a member can be asked what
 * theirs says when a pass looks stale. Keep it short and readable aloud.
 */
export const PASS_CONTENT_VERSION = "2026-09-18.1";

export function buildPassJson(
  member: MemberPassInput,
  config: PassKitConfig,
  builtAt: Date = new Date(),
): Uint8Array {
  const secondaryFields: PassField[] = [];
  if (member.memberSince) {
    secondaryFields.push({
      key: "member_since",
      label: "Member Since",
      value: formatMonthYear(member.memberSince),
      textAlignment: "PKTextAlignmentLeft",
    });
  }
  if (member.expirationDate) {
    secondaryFields.push({
      key: "membership_expiry",
      label: "Good through",
      value: formatShortDate(member.expirationDate),
      textAlignment: "PKTextAlignmentLeft",
    });
  }

  const backFields: PassField[] = [
    {
      key: "member_id",
      label: "Card #",
      value: member.memberId,
      textAlignment: "PKTextAlignmentLeft",
    },
  ];
  if (member.status !== "active") {
    backFields.push({
      key: "status",
      label: "Status",
      value: member.status === "expired" ? "Expired" : "Revoked",
      textAlignment: "PKTextAlignmentLeft",
    });
  }

  // Last, below everything anyone reads on purpose. Nobody needs these, which
  // is why they can be asked for: "what does the bottom of the back say?" is
  // a question a member can answer over a message, and between them the
  // answers settle the questions a stale-looking pass actually raises.
  //
  // `Built` is the more useful of the two in practice -- a date can be
  // compared against when a fix shipped without anyone having to remember
  // what the version before it was.
  if (config.environment && config.environment !== "production") {
    backFields.push({
      key: "environment",
      label: "Environment",
      value: config.environment,
      textAlignment: "PKTextAlignmentLeft",
    });
  }
  backFields.push(
    {
      key: "card_version",
      label: "Card version",
      value: PASS_CONTENT_VERSION,
      textAlignment: "PKTextAlignmentLeft",
    },
    {
      key: "built_at",
      label: "Built",
      value: builtAt.toISOString().slice(0, 10),
      textAlignment: "PKTextAlignmentLeft",
    },
  );

  const pass: PassJson = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeIdentifier,
    serialNumber: member.memberId,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName,
    description: "Los Verdes Membership Card",
    suppressStripShine: false,
    generic: {
      primaryFields: [
        {
          key: "name",
          label: "Member Name",
          value: `${member.firstName} ${member.lastName}`,
          textAlignment: "PKTextAlignmentLeft",
        },
      ],
      secondaryFields,
      auxiliaryFields: [
        {
          key: "membership_tier",
          label: "Tier",
          value: member.membershipTier,
          textAlignment: "PKTextAlignmentLeft",
        },
      ],
      backFields,
    },
    barcode: {
      format: "PKBarcodeFormatQR",
      message: member.verifyUrl,
      messageEncoding: "iso-8859-1",
      altText: "",
    },
    backgroundColor: "rgb(0, 177, 64)",
    foregroundColor: "rgb(0, 0, 0)",
    logoText: "Los Verdes",
    authenticationToken: member.authToken,
    webServiceURL: config.webServiceURL,
  };

  return new TextEncoder().encode(JSON.stringify(pass));
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

/**
 * Cached passes are tagged with two things: the `members.last_updated_at`
 * they were generated from, and the `PASS_CONTENT_VERSION` the code was on.
 * A cached pass is served only while both still match.
 *
 * The first covers the member changing. Any write path that bumps
 * `last_updated_at` (BigCommerce sync, the legacy import SQL, future admin
 * actions) invalidates the cache implicitly -- there's no separate
 * invalidation call to forget, including from raw SQL that can't reach R2.
 *
 * The second covers *us* changing. A member whose details are stable never
 * bumps `last_updated_at`, so a change to what a pass contains would
 * otherwise never reach them: they would keep being handed the pass built by
 * the old code, for as long as nothing else about them moved.
 *
 * Either way the next put overwrites the stale object in place.
 */
const LAST_UPDATED_AT_METADATA = "lastUpdatedAt";
const CONTENT_VERSION_METADATA = "passContentVersion";

/**
 * Reads a previously-generated `.pkpass` from R2's Phase 3.3 cache, or
 * `null` on a miss or when it was generated from an older member version.
 */
export async function getCachedPass(
  bucket: R2Bucket,
  passTypeIdentifier: string,
  serialNumber: string,
  lastUpdatedAt: number,
): Promise<Uint8Array | null> {
  const object = await bucket.get(cacheKey(passTypeIdentifier, serialNumber));
  if (
    !object ||
    object.customMetadata?.[LAST_UPDATED_AT_METADATA] !== String(lastUpdatedAt) ||
    object.customMetadata?.[CONTENT_VERSION_METADATA] !== PASS_CONTENT_VERSION
  ) {
    return null;
  }
  return new Uint8Array(await object.arrayBuffer());
}

/** Writes a generated `.pkpass` to R2's Phase 3.3 cache, tagged with its member version. */
export async function putCachedPass(
  bucket: R2Bucket,
  passTypeIdentifier: string,
  serialNumber: string,
  lastUpdatedAt: number,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(cacheKey(passTypeIdentifier, serialNumber), bytes, {
    httpMetadata: { contentType: "application/vnd.apple.pkpass" },
    customMetadata: {
      [LAST_UPDATED_AT_METADATA]: String(lastUpdatedAt),
      [CONTENT_VERSION_METADATA]: PASS_CONTENT_VERSION,
    },
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
