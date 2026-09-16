/**
 * Builds the `pass.json` content for a member's Apple Wallet pass (Phase 4
 * of `.ai/gcp-to-cf_plan.md`). Field structure (which fields appear, their
 * labels, and date formatting) was reverse-engineered from a real pass
 * pulled from the legacy production app, not invented from the Apple
 * PassKit spec alone -- see the field-by-field notes below.
 *
 * Deliberately does not sign or ZIP anything -- this only builds the JSON
 * content. Manifest hashing / PKCS#7 signing (see
 * src/spikes/pkcs7-signing/) and ZIP assembly are separate concerns.
 *
 * Two things the real example pass did that this intentionally does NOT
 * replicate, since they look like legacy-app bugs rather than deliberate
 * behavior: its `organizationName` was set to the Apple Developer Team ID
 * instead of a human-readable name (here it's a distinct, configured
 * value), and its `backgroundColor` was a malformed `"rgb((0, 177, 64)"`
 * string (missing/extra parens) rather than valid `"rgb(0, 177, 64)"`.
 */

export type PassTextAlignment =
  | "PKTextAlignmentLeft"
  | "PKTextAlignmentCenter"
  | "PKTextAlignmentRight"
  | "PKTextAlignmentNatural";

export interface PassField {
  key: string;
  label: string;
  value: string;
  textAlignment: PassTextAlignment;
}

export interface PassJson {
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

/** The subset of a `members` row (see src/db/schema.sql) this pass's content depends on. */
export interface PassContentMember {
  /** `members.member_id` - doubles as both `serialNumber` and the displayed
   * "Card #" back-field. The real example pass used two different values for
   * these (an internal numeric serial vs. a public UUID), which this
   * simplifies away now that `registrations.serial_number` already keys
   * directly off `member_id` (Phase 2.1). */
  memberId: string;
  firstName: string;
  lastName: string;
  /** ISO8601 `YYYY-MM-DD`, or `null` if not yet backfilled/known (Phase 2.2). */
  memberSince: string | null;
  /** ISO8601 `YYYY-MM-DD`, or `null` for a membership with no expiry on record. */
  expirationDate: string | null;
  /** `members.auth_token` - becomes `pass.json`'s `authenticationToken`, used
   * by Apple's device-registration/pass-delivery endpoints (Phase 4.1/4.3). */
  authToken: string;
  /** Fully-formed, already HMAC-signed `/verify-pass/...` URL for the QR
   * barcode. Computing and signing this URL is a separate concern (needs
   * `PASS_SIGNATURE_KEY`, Phase 2.3.1) from building pass content, so it's
   * passed in ready-made rather than computed here. */
  verifyUrl: string;
}

/** Per-deployment PassKit identifiers/branding - not member-specific. */
export interface PassKitConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
  webServiceURL: string;
  /** e.g. `"rgb(0, 177, 64)"` - must be well-formed; Wallet silently falls
   * back to a default appearance on a malformed value rather than erroring. */
  backgroundColor: string;
  foregroundColor: string;
  logoText: string;
}

function formatMemberSince(isoDate: string): string {
  // e.g. "Jul 2021" - matches the real example pass's "Member Since" field.
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

function formatExpirationDate(isoDate: string): string {
  // e.g. "Feb 17, 2024" - matches the real example pass's "Good through" field.
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

export function buildPassJson(
  member: PassContentMember,
  config: PassKitConfig,
): PassJson {
  const secondaryFields: PassField[] = [];
  if (member.memberSince) {
    secondaryFields.push({
      key: "member_since",
      label: "Member Since",
      value: formatMemberSince(member.memberSince),
      textAlignment: "PKTextAlignmentLeft",
    });
  }
  if (member.expirationDate) {
    secondaryFields.push({
      key: "membership_expiry",
      label: "Good through",
      value: formatExpirationDate(member.expirationDate),
      textAlignment: "PKTextAlignmentLeft",
    });
  }

  return {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeIdentifier,
    serialNumber: member.memberId,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName,
    description: config.description,
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
      backFields: [
        {
          key: "member_id",
          label: "Card #",
          value: member.memberId,
          textAlignment: "PKTextAlignmentLeft",
        },
      ],
    },
    barcode: {
      format: "PKBarcodeFormatQR",
      message: member.verifyUrl,
      messageEncoding: "iso-8859-1",
      altText: "",
    },
    backgroundColor: config.backgroundColor,
    foregroundColor: config.foregroundColor,
    logoText: config.logoText,
    authenticationToken: member.authToken,
    webServiceURL: config.webServiceURL,
  };
}
