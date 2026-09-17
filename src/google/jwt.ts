import { SignJWT, importPKCS8 } from "jose";
import { formatMonthYear, formatShortDate } from "../lib/dateFormat";

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
}

/** The subset of a `members` row (Phase 2.1) needed to build a Google Wallet object. */
export interface MemberWalletInput {
  memberId: string; // == the GenericObject id suffix and the QR code's alternate text
  firstName: string;
  lastName: string;
  membershipTier: string;
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
 * tier/member-since/expiry as secondary text, status folded into a single
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
}

/** The "Save to Google Wallet" JWT payload shape specified in Phase 5.2. */
export interface SaveToWalletPayload {
  iss: string;
  aud: "google";
  typ: "savetogooglewallet";
  origins: string[];
  payload: {
    genericObjects: GenericObject[];
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
 * Maps this project's `members.status` (Phase 2.1) to Google Wallet's
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
): GenericObject {
  const textModulesData: TextModuleData[] = [
    {
      id: "membership_tier",
      header: "Tier",
      body: member.membershipTier,
    },
  ];
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

  return {
    id: objectId(config, member),
    classId: classId(config),
    cardTitle: localizedString(config.cardTitle),
    header: localizedString(`${member.firstName} ${member.lastName}`),
    textModulesData,
    barcode: {
      type: "QR_CODE",
      value: member.verifyUrl,
      alternateText: member.memberId,
    },
    hexBackgroundColor: config.hexBackgroundColor,
    state: objectState(member.status),
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
): SaveToWalletPayload {
  return {
    iss: serviceAccountEmail,
    aud: "google",
    typ: "savetogooglewallet",
    origins: config.origins,
    payload: {
      genericObjects: [buildGenericObject(member, config)],
    },
  };
}

/**
 * Signs the Phase 5.2 "Save to Google Wallet" JWT with RS256, using Web
 * Crypto via `jose` (per the migration plan's Phase 5.2 -- no Google API
 * client library needed). `credentials.privateKeyPem` is expected to be the
 * service account JSON's `private_key` field verbatim (PKCS#8 PEM), which
 * is exactly what Google issues and what `jose#importPKCS8` expects.
 */
export async function signSaveToWalletJwt(
  member: MemberWalletInput,
  config: GoogleWalletConfig,
  credentials: GoogleWalletCredentials,
): Promise<string> {
  const payload = buildSaveToWalletPayload(
    member,
    config,
    credentials.serviceAccountEmail,
  );
  const privateKey = await importPKCS8(credentials.privateKeyPem, "RS256");

  // `jose`'s JWTPayload type requires an index signature for arbitrary
  // claims; SaveToWalletPayload is deliberately typed narrowly above for
  // callers building the payload, so widen it just for the signing call.
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(privateKey);
}

/** Builds the "Save to Google Wallet" link (Phase 5.2, step 3) from a signed JWT. */
export function buildSaveToWalletUrl(signedJwt: string): string {
  return `https://pay.google.com/gp/v/save/${signedJwt}`;
}
