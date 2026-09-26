import { CLASSIC_THEME, type CardTheme } from "../themes/cardTheme";
import { SignJWT, importPKCS8 } from "jose";
import { formatMonthYear, formatShortDate } from "../lib/dateFormat";
import { PASS_CONTENT_VERSION, membershipEndsAt } from "../passkit/generator";

/**
 * Google Wallet service-account credentials needed to sign a "Save to
 * Google Wallet" JWT (Phase 5.2). Mirrors the shape of
 * `PassSigningCredentials` in `../passkit/signer.ts`: a real Google Wallet
 * service-account key isn't available in this environment yet (see the
 * migration plan's Phase 0.2 credential inventory), so this module accepts
 * the credentials as parameters rather than reading Worker secrets
 * directly. It works against any valid RS256 key pair -- including a
 * throwaway test key -- so it's fully testable today and becomes real the
 * moment the real service-account JSON is populated into Worker secrets, no
 * code change needed.
 */
export interface GoogleWalletCredentials {
  /** The service account JSON's `client_email` field -- becomes the JWT `iss` claim. */
  serviceAccountEmail: string;
  /** The service account JSON's `private_key` field, PEM-encoded PKCS#8, verbatim. */
  privateKeyPem: string;
}

/** Static, non-secret Google Wallet identifiers -- one set per deployment environment. */
export interface GoogleWalletConfig {
  /** Google Wallet Issuer ID (numeric, assigned via the Google Pay & Wallet Console). */
  issuerId: string;
  /** Suffix identifying the `GenericClass`; the full class id is `${issuerId}.${classSuffix}` (Phase 5.1, e.g. `los_verdes_member_v1`). */
  classSuffix: string;
  /** Origins allowed to render the "Save to Google Wallet" button -- the JWT's `origins` claim. */
  origins: string[];
  /** Card branding text shown as the `GenericObject`'s `cardTitle` (e.g. "Los Verdes"). */
  cardTitle: string;
  /** Hex background color for the card, e.g. `"#00B140"`. */
  hexBackgroundColor: string;
  /**
   * Absolute URL of the pass logo. Google fetches this itself, so it has to be
   * publicly reachable -- served by `src/assets.ts`, not from R2 directly.
   */
  logoUri: string;
}

/**
 * Branding shared by every environment -- only the issuer, class and origins
 * differ. Exported so `scripts/google-wallet-check.ts` validates the object
 * this Worker actually issues, rather than a second copy of these values that
 * could drift from it.
 */
export const GOOGLE_WALLET_BRANDING = {
  cardTitle: "Los Verdes",
  hexBackgroundColor: CLASSIC_THEME.colors.background.toUpperCase(),
} as const;

/**
 * Path the pass logo is served from (`src/assets.ts`). Google fetches this
 * itself, so it is resolved against the environment's public origin.
 */
export const LOGO_ASSET_PATH = CLASSIC_THEME.assets.googleLogoPath;

/** A card theme's Google branding for one member (#333): what varies per object rather than per class. */
export interface GoogleWalletTheme {
  hexBackgroundColor: string;
  logoUri: string;
}

/** A card theme as Google needs it, the logo resolved against the environment's public origin. */
export function googleWalletTheme(theme: CardTheme, baseUrl: string): GoogleWalletTheme {
  return {
    hexBackgroundColor: theme.colors.background.toUpperCase(),
    logoUri: new URL(theme.assets.googleLogoPath, baseUrl).toString(),
  };
}

/**
 * The whole config for an environment, from the three things that differ
 * between them.
 *
 * Exported and used by `scripts/google-wallet-check.ts` as well as the Worker,
 * because assembling it in two places is how the checker came to validate an
 * object with no logo while the Worker was issuing one correctly: adding a
 * required field to `GoogleWalletConfig` left the second copy behind, and
 * Google reported only "URL cannot be empty" (2026-09-18).
 */
export function googleWalletConfig(env: {
  issuerId: string;
  classSuffix: string;
  baseUrl: string;
}): GoogleWalletConfig {
  return {
    issuerId: env.issuerId,
    classSuffix: env.classSuffix,
    origins: [env.baseUrl],
    ...GOOGLE_WALLET_BRANDING,
    logoUri: new URL(LOGO_ASSET_PATH, env.baseUrl).toString(),
  };
}

/** The subset of a `members` row (Phase 2.1) needed to build a Google Wallet object. */
export interface MemberWalletInput {
  memberId: string; // == the GenericObject id suffix and the QR code's alternate text
  firstName: string;
  lastName: string;
  status: "active" | "expired" | "revoked";
  expirationDate: string | null; // ISO8601 date (YYYY-MM-DD), or null if unset
  /** ISO8601 date (YYYY-MM-DD), or null if not yet known/backfilled (Phase 2.2). */
  memberSince: string | null;
  /** Signed `/verify-pass` URL encoded in the QR code (`buildVerifyPassUrl`). */
  verifyUrl: string;
}

interface LocalizedString {
  defaultValue: {
    language: "en-US";
    value: string;
  };
}

interface TextModuleData {
  id: string;
  header: string;
  body: string;
}

type GenericObjectState = "ACTIVE" | "EXPIRED" | "INACTIVE";

/**
 * The subset of Google Wallet's `GenericObject` resource this project
 * populates -- see Phase 5.1/5.2. Field structure mirrors
 * `../passkit/generator.ts`'s `PassJson` (name as the prominent header,
 * member-since/expiry as secondary text, status folded into a single
 * field) adapted to Google Wallet's own object shape rather than Apple's.
 */
export interface GenericObject {
  id: string;
  classId: string;
  cardTitle: LocalizedString;
  header: LocalizedString;
  textModulesData: TextModuleData[];
  barcode: {
    type: "QR_CODE";
    value: string;
    alternateText: string;
  };
  hexBackgroundColor: string;
  state: GenericObjectState;
  /**
   * When Google should move the pass to "Expired passes" by itself, up to 24
   * hours after `end` (#295). Absent when there is no expiry to state.
   */
  validTimeInterval?: { end: { date: string } };
  /** Required by Google on a generic object; omitting it fails the save with no usable error. */
  logo: {
    sourceUri: { uri: string };
    contentDescription: LocalizedString;
  };
}

/**
 * The "Save to Google Wallet" JWT claims, per Google's JWT reference
 * (https://developers.google.com/wallet/reference/rest/v1/Jwt). `typ` is
 * exactly `savetowallet` and `iat` is required: with `savetogooglewallet` and
 * no `iat`, the REST API still accepted the object, but every save link
 * failed with Google's generic "Something went wrong" (found 2026-09-18, #96).
 */
export interface SaveToWalletPayload {
  iss: string;
  aud: "google";
  typ: "savetowallet";
  /** Issued-at, seconds since the epoch. */
  iat: number;
  origins: string[];
  payload: {
    /** Whole objects, or -- the "skinny" form -- just the ids of objects already written via the API. */
    genericObjects: (GenericObject | { id: string })[];
  };
}

function classId(config: GoogleWalletConfig): string {
  return `${config.issuerId}.${config.classSuffix}`;
}

function objectId(
  config: GoogleWalletConfig,
  member: MemberWalletInput,
): string {
  return `${config.issuerId}.${member.memberId}`;
}

function localizedString(value: string): LocalizedString {
  return { defaultValue: { language: "en-US", value } };
}

/**
 * Maps a member's effective status (`effectiveStatus()`) to Google Wallet's
 * `GenericObject.state` enum. There's no dedicated "revoked" state in
 * Google's model -- `INACTIVE` is the closest fit (hides the pass from the
 * holder's default Wallet view), distinct from `EXPIRED`'s date-based UI
 * treatment.
 */
function objectState(status: MemberWalletInput["status"]): GenericObjectState {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "expired":
      return "EXPIRED";
    case "revoked":
      return "INACTIVE";
  }
}

/**
 * Builds the `GenericObject` payload for a real Los Verdes membership pass
 * (Phase 5.1). Pure function of its inputs, mirroring
 * `passkit/generator.ts#buildPassJson`'s shape and conventions (conditional
 * member-since/expiry fields, QR code encoding the signed `/verify-pass` URL
 * with the member id as its alternate text).
 */
export function buildGenericObject(
  member: MemberWalletInput,
  config: GoogleWalletConfig,
  theme: GoogleWalletTheme = { hexBackgroundColor: config.hexBackgroundColor, logoUri: config.logoUri },
): GenericObject {
  const textModulesData: TextModuleData[] = [];
  if (member.memberSince) {
    textModulesData.push({
      id: "member_since",
      header: "Member Since",
      body: formatMonthYear(member.memberSince),
    });
  }
  if (member.expirationDate) {
    textModulesData.push({
      id: "membership_expiry",
      header: "Good through",
      body: formatShortDate(member.expirationDate),
    });
  }

  // Last, for the same reason it is the last back field on the Apple pass:
  // it is there to be asked for, not to be read.
  textModulesData.push({
    id: "card_version",
    header: "Card version",
    body: PASS_CONTENT_VERSION,
  });

  return {
    id: objectId(config, member),
    classId: classId(config),
    cardTitle: localizedString(config.cardTitle),
    header: localizedString(`${member.firstName} ${member.lastName}`.trim()),
    textModulesData,
    barcode: {
      type: "QR_CODE",
      value: member.verifyUrl,
      alternateText: member.memberId,
    },
    hexBackgroundColor: theme.hexBackgroundColor,
    state: objectState(member.status),
    ...(member.expirationDate
      ? { validTimeInterval: { end: { date: membershipEndsAt(member.expirationDate) } } }
      : {}),
    logo: {
      sourceUri: { uri: theme.logoUri },
      contentDescription: localizedString(config.cardTitle),
    },
  };
}

/**
 * Builds the full "Save to Google Wallet" JWT payload (Phase 5.2) -- the
 * `iss`/`aud`/`typ`/`origins` envelope around a single `genericObjects`
 * entry. Pure and synchronous so it's independently testable from signing.
 */
export function buildSaveToWalletPayload(
  member: MemberWalletInput,
  config: GoogleWalletConfig,
  serviceAccountEmail: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SaveToWalletPayload {
  return {
    iss: serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    iat: nowSeconds,
    origins: config.origins,
    payload: {
      genericObjects: [buildGenericObject(member, config)],
    },
  };
}

/**
 * The "skinny" save payload: the same envelope around only an object id.
 * For a pass that has already been written through the REST API
 * (`src/google/api.ts`), this is all the link needs, and it stays far under
 * Google's 1,800-character safe length for a save link, which a link that
 * carries the whole object does not (#96).
 */
export function buildSkinnySaveToWalletPayload(
  objectId: string,
  config: GoogleWalletConfig,
  serviceAccountEmail: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SaveToWalletPayload {
  return {
    iss: serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    iat: nowSeconds,
    origins: config.origins,
    payload: { genericObjects: [{ id: objectId }] },
  };
}

/**
 * Signs a "Save to Google Wallet" payload with RS256, using Web Crypto via
 * `jose` (per the migration plan's Phase 5.2 -- no Google API client library
 * needed). `credentials.privateKeyPem` is expected to be the service account
 * JSON's `private_key` field verbatim (PKCS#8 PEM), which is exactly what
 * Google issues and what `jose#importPKCS8` expects.
 */
export async function signSaveToWalletPayload(
  payload: SaveToWalletPayload,
  credentials: GoogleWalletCredentials,
): Promise<string> {
  const privateKey = await importPKCS8(credentials.privateKeyPem, "RS256");
  // `jose`'s JWTPayload type requires an index signature for arbitrary
  // claims; SaveToWalletPayload is deliberately typed narrowly above for
  // callers building the payload, so widen it just for the signing call.
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(privateKey);
}

/** Signs the full-object save JWT for `member` (see `buildSaveToWalletPayload`). */
export async function signSaveToWalletJwt(
  member: MemberWalletInput,
  config: GoogleWalletConfig,
  credentials: GoogleWalletCredentials,
): Promise<string> {
  return signSaveToWalletPayload(
    buildSaveToWalletPayload(member, config, credentials.serviceAccountEmail),
    credentials,
  );
}

/** Builds the "Save to Google Wallet" link (Phase 5.2, step 3) from a signed JWT. */
export function buildSaveToWalletUrl(signedJwt: string): string {
  return `https://pay.google.com/gp/v/save/${signedJwt}`;
}
