/**
 * Shared "a member and their card artifacts" layer: looking members up and
 * producing their Apple Wallet pass, card image, and Google Wallet save link.
 * Used by the PassKit web service, the member portal, and email card
 * delivery, so all three show identical data (e.g. the `member_since`
 * override) and none of them re-implement the glue around the pure
 * generators in src/passkit, src/cardimage, and src/google.
 */

import { renderMembershipCardPng } from "../cardimage/render";
import {
  buildSaveToWalletUrl,
  signSaveToWalletJwt,
  type GoogleWalletConfig,
} from "../google/jwt";
import type { Env } from "../index";
import { buildVerifyPassUrl } from "../lib/passSignature";
import {
  assemblePassBundle,
  getCachedPass,
  putCachedPass,
} from "../passkit/generator";

export interface MemberRecord {
  member_id: string;
  email: string;
  first_name: string;
  last_name: string;
  membership_tier: string;
  status: "active" | "expired" | "revoked";
  expiration_date: string | null;
  /** Effective value: a `member_since_overrides` row wins (migration 0005). */
  member_since: string | null;
  auth_token: string;
  last_updated_at: number;
}

const MEMBER_SELECT = `SELECT m.member_id, m.email, m.first_name, m.last_name, m.membership_tier,
         m.status, m.expiration_date,
         COALESCE(o.member_since, m.member_since) AS member_since,
         m.auth_token, m.last_updated_at
  FROM members m LEFT JOIN member_since_overrides o ON o.email = m.email`;

export async function getMemberById(
  env: Env,
  memberId: string,
): Promise<MemberRecord | null> {
  return env.DB.prepare(`${MEMBER_SELECT} WHERE m.member_id = ?`)
    .bind(memberId)
    .first<MemberRecord>();
}

export async function getMemberByEmail(
  env: Env,
  email: string,
): Promise<MemberRecord | null> {
  return env.DB.prepare(`${MEMBER_SELECT} WHERE m.email = ?`)
    .bind(email.trim().toLowerCase())
    .first<MemberRecord>();
}

/**
 * Whether a membership is current. Checks `expiration_date` directly rather
 * than trusting `status = 'active'`, which is only recomputed when a sync
 * touches the row.
 */
export function isMembershipCurrent(
  member: Pick<MemberRecord, "status" | "expiration_date">,
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  return (
    member.status !== "revoked" &&
    member.expiration_date !== null &&
    member.expiration_date >= today
  );
}

function verifyUrl(env: Env, member: MemberRecord): Promise<string> {
  return buildVerifyPassUrl(
    env.PUBLIC_BASE_URL,
    env.PASS_SIGNATURE_KEY,
    member.member_id,
  );
}

/** Template images committed under assets/templates/ and synced to R2 on deploy. */
async function readTemplateAsset(env: Env, key: string): Promise<Uint8Array> {
  const object = await env.ASSETS.get(key);
  if (!object) {
    throw new Error(
      `Missing template asset in R2: ${key} (committed under assets/; upload with \`just r2-upload-templates\`)`,
    );
  }
  return new Uint8Array(await object.arrayBuffer());
}

// Matches Phase 3.1's R2 `templates/apple/` layout -- no strip.png or
// thumbnail.png: it's a `generic`-style pass, which doesn't render a strip.
const PASS_TEMPLATE_ASSETS = [
  "icon.png",
  "icon@2x.png",
  "logo.png",
  "logo@2x.png",
];

/**
 * The member's signed `.pkpass`, served from the R2 cache (keyed to
 * `last_updated_at`) when possible; only pays the signing cost on a miss.
 */
export async function getApplePassBundle(
  env: Env,
  member: MemberRecord,
): Promise<Uint8Array> {
  const passTypeIdentifier = env.PASSKIT_PASS_TYPE_IDENTIFIER;
  const cached = await getCachedPass(
    env.ASSETS,
    passTypeIdentifier,
    member.member_id,
    member.last_updated_at,
  );
  if (cached) {
    return cached;
  }

  const assets: Record<string, Uint8Array> = {};
  for (const name of PASS_TEMPLATE_ASSETS) {
    assets[name] = await readTemplateAsset(env, `templates/apple/${name}`);
  }
  const bundle = await assemblePassBundle(
    {
      memberId: member.member_id,
      firstName: member.first_name,
      lastName: member.last_name,
      membershipTier: member.membership_tier,
      status: member.status,
      expirationDate: member.expiration_date,
      memberSince: member.member_since,
      authToken: member.auth_token,
      verifyUrl: await verifyUrl(env, member),
    },
    {
      passTypeIdentifier,
      teamIdentifier: env.PASSKIT_TEAM_IDENTIFIER,
      organizationName: env.PASSKIT_ORGANIZATION_NAME,
      webServiceURL: env.PASSKIT_WEB_SERVICE_URL,
    },
    assets,
    {
      signingCertPem: env.APPLE_PASS_CERT_PEM,
      signingKeyPem: env.APPLE_PASS_KEY_PEM,
      wwdrCertPem: env.APPLE_WWDR_CERT_PEM,
    },
  );
  await putCachedPass(
    env.ASSETS,
    passTypeIdentifier,
    member.member_id,
    member.last_updated_at,
    bundle,
  );
  return bundle;
}

/**
 * The member's card image (PNG). Uses a dedicated 256px crest rather than the
 * pass icon, which at 58px is too small for the ~120px crest on the card.
 */
export async function renderCardImage(
  env: Env,
  member: MemberRecord,
): Promise<Uint8Array> {
  return renderMembershipCardPng(
    {
      firstName: member.first_name,
      lastName: member.last_name,
      membershipTier: member.membership_tier,
      memberId: member.member_id,
      verifyUrl: await verifyUrl(env, member),
      expirationDate: member.expiration_date,
    },
    await readTemplateAsset(env, "templates/card/crest.png"),
  );
}

/**
 * Whether the Google Wallet service-account secrets are set. A type guard, so
 * callers get both values as plain strings once it passes.
 */
export function isGoogleWalletConfigured(env: Env): env is Env & {
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_WALLET_PRIVATE_KEY_PEM: string;
} {
  return Boolean(
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL &&
      env.GOOGLE_WALLET_PRIVATE_KEY_PEM,
  );
}

/**
 * A "Save to Google Wallet" link for the member. Throws if Google Wallet
 * isn't configured (`GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` /
 * `GOOGLE_WALLET_PRIVATE_KEY_PEM` secrets).
 */
export async function buildGoogleWalletSaveUrl(
  env: Env,
  member: MemberRecord,
): Promise<string> {
  if (!isGoogleWalletConfigured(env)) {
    throw new Error("Google Wallet credentials are not configured");
  }
  const config: GoogleWalletConfig = {
    issuerId: env.GOOGLE_WALLET_ISSUER_ID,
    classSuffix: env.GOOGLE_WALLET_CLASS_SUFFIX,
    origins: [env.PUBLIC_BASE_URL],
    cardTitle: "Los Verdes",
    hexBackgroundColor: "#00B140",
  };
  const jwt = await signSaveToWalletJwt(
    {
      memberId: member.member_id,
      firstName: member.first_name,
      lastName: member.last_name,
      membershipTier: member.membership_tier,
      status: member.status,
      expirationDate: member.expiration_date,
      memberSince: member.member_since,
      verifyUrl: await verifyUrl(env, member),
    },
    config,
    {
      serviceAccountEmail: env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.GOOGLE_WALLET_PRIVATE_KEY_PEM,
    },
  );
  return buildSaveToWalletUrl(jwt);
}
