/**
 * Shared "a member and their card artifacts" layer: looking members up and
 * producing their Apple Wallet pass, card image, and Google Wallet save link.
 * Used by the PassKit web service, the member portal, and email card
 * delivery, so all three show identical data (e.g. the `member_since`
 * override) and none of them re-implement the glue around the pure
 * generators in src/passkit, src/cardimage, and src/google.
 */

import {
  updateGenericObjectIfPresent,
  upsertGenericObject,
} from "../google/api";
import {
  buildGenericObject,
  buildSaveToWalletUrl,
  buildSkinnySaveToWalletPayload,
  googleWalletConfig,
  googleWalletTheme,
  signSaveToWalletPayload,
} from "../google/jwt";
import type { Env } from "../index";
import { buildVerifyPassUrl } from "../lib/passSignature";
import {
  assemblePassBundle,
  getCachedPass,
  putCachedPass,
} from "../passkit/generator";
import {
  APPLE_THUMBNAIL_FILES,
  resolveCardTheme,
  themeCacheTag,
  type CardTheme,
} from "../themes/cardTheme";

export interface MemberRecord {
  member_id: string;
  email: string;
  first_name: string;
  last_name: string;
  /**
   * 1 when the membership is revoked or its holder expelled. All the
   * database can say about standing: whether an unrevoked membership is
   * active or expired depends on today's date, which is `effectiveStatus()`'s
   * to answer.
   */
  revoked: 0 | 1;
  /** Null when revoked: there is no "good through" that means anything. */
  expiration_date: string | null;
  /** Effective value: a `member_since_overrides` row wins. */
  member_since: string | null;
  /**
   * What the member (or an admin) asked to be shown instead of the name
   * derived from their orders; null when nobody has asked for anything.
   * The derived `first_name`/`last_name` stay as they are underneath, so
   * clearing this puts the card back to them.
   */
  display_name: string | null;
  auth_token: string;
  last_updated_at: number;
}

/**
 * One member, with everything that overrides what the order sync derived.
 *
 * A revocation is resolved here rather than by the callers, which is what
 * makes the rest of this cheap: the access checks, the Apple pass's status
 * field, the Google object's state and the admin screens all read `revoked`
 * off this one `SELECT`, so none of them has to be told where a revocation
 * is kept.
 *
 * The expiry is dropped with it, so a revoked membership reads as expired
 * everywhere that asks a date rather than a status -- there is no longer a
 * "good through" that means anything. The underlying `members` row is left
 * alone, so lifting a revocation is a single delete.
 *
 * An expulsion does the same to the membership, resolved here rather than by
 * writing a second row, so that lifting the expulsion restores the membership by
 * itself. Somebody can be both expelled and separately revoked; lifting one
 * then correctly leaves the other standing.
 */
const MEMBER_SELECT = `SELECT m.member_id, m.email, m.first_name, m.last_name,
         (r.member_id IS NOT NULL OR b.email IS NOT NULL) AS revoked,
         CASE WHEN r.member_id IS NOT NULL OR b.email IS NOT NULL THEN NULL ELSE m.expiration_date END AS expiration_date,
         COALESCE(o.member_since, m.member_since) AS member_since,
         d.display_name,
         m.auth_token, m.last_updated_at
  FROM members m
       LEFT JOIN member_since_overrides o ON o.email = m.email
       LEFT JOIN member_display_names d ON d.email = m.email
       LEFT JOIN revoked_cards r ON r.member_id = m.member_id
       LEFT JOIN expelled_people b ON b.email = m.email`;

/**
 * The name to put on a card, as the two fields every renderer expects.
 *
 * A display name is one free-text field, so it goes in
 * `firstName` whole and leaves `lastName` empty -- a name someone chose is
 * not ours to split, and several of them would not survive being split.
 * Callers join the two with a space and trim.
 */
export function cardName(
  member: Pick<MemberRecord, "display_name" | "first_name" | "last_name">,
): { firstName: string; lastName: string } {
  if (member.display_name) return { firstName: member.display_name, lastName: "" };
  return { firstName: member.first_name, lastName: member.last_name };
}

/** The same name as one string, for the places that want it that way. */
export function cardNameText(
  member: Pick<MemberRecord, "display_name" | "first_name" | "last_name">,
): string {
  const { firstName, lastName } = cardName(member);
  return `${firstName} ${lastName}`.trim();
}

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

/** A member found by name, with the Slack handle that matched them, if any. */
export interface NameMatch extends MemberRecord {
  slack_handle: string | null;
}

/** `LIKE` treats `%` and `_` as wildcards; an admin typing either means the character. */
function likeContaining(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Members whose name contains `text`, for the admin name search (#320):
 * the name their orders give, the name on their card, or their Slack name
 * or handle. `slackHandleOnly` narrows it to the handle, for an admin who
 * typed one.
 *
 * Through `MEMBER_SELECT` like every other member read, so a revoked or
 * expelled person shows as such here without this knowing why.
 *
 * `LIKE` folds case for ASCII only, so `jose` does not find `José`. Worth a
 * folded search column if that turns out to matter; the lists are short
 * enough that nothing else needs an index.
 */
export async function findMembersByName(
  env: Env,
  text: string,
  options: { slackHandleOnly?: boolean; limit: number },
): Promise<NameMatch[]> {
  const slackHandle = `(s.name LIKE ?1 ESCAPE '\\' OR json_extract(s.profile, '$.display_name') LIKE ?1 ESCAPE '\\')`;
  const where = options.slackHandleOnly
    ? `EXISTS (SELECT 1 FROM slack_users s WHERE s.email = m.email AND ${slackHandle})`
    : `(m.first_name || ' ' || m.last_name) LIKE ?1 ESCAPE '\\'
       OR d.display_name LIKE ?1 ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM slack_users s WHERE s.email = m.email
                  AND (${slackHandle} OR s.real_name LIKE ?1 ESCAPE '\\'))`;
  const { results } = await env.DB.prepare(
    `SELECT found.*,
            (SELECT COALESCE(NULLIF(json_extract(s.profile, '$.display_name'), ''), s.name)
               FROM slack_users s WHERE s.email = found.email
              ORDER BY s.deleted, s.synced_at DESC LIMIT 1) AS slack_handle
       FROM (${MEMBER_SELECT} WHERE ${where}) AS found
      ORDER BY found.last_name COLLATE NOCASE, found.first_name COLLATE NOCASE, found.email
      LIMIT ?2`,
  )
    .bind(likeContaining(text), options.limit)
    .all<NameMatch>();
  return results;
}

/**
 * Whether a membership is current: not revoked, and good through today or
 * later. Asked of the date every time rather than stored, since a stored
 * answer goes stale the day after it is written.
 */
export function isMembershipCurrent(
  member: Pick<MemberRecord, "revoked" | "expiration_date">,
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  return (
    !member.revoked &&
    member.expiration_date !== null &&
    member.expiration_date >= today
  );
}

/**
 * The status a pass should carry, worked out at the moment it is built.
 *
 * Nothing stores this. Revocation is a stored decision and arrives as
 * `revoked`; the rest is derived from the expiry date against `today`, which
 * is a parameter so a test can pin it.
 *
 * Note the limit of this: a pass already on a device or cached in R2 is not
 * rebuilt just because a date passed. It fixes what a pass says when it *is*
 * rebuilt -- on a renewal, an attribution, a re-download -- rather than
 * reaching out to correct one already issued.
 */
export function effectiveStatus(
  member: Pick<MemberRecord, "revoked" | "expiration_date">,
  today: string = new Date().toISOString().slice(0, 10),
): "active" | "expired" | "revoked" {
  if (member.revoked) {
    return "revoked";
  }
  return isMembershipCurrent(member, today) ? "active" : "expired";
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

// Matches Phase 3.1's R2 `templates/apple/` layout -- no strip.png: it's a
// `generic`-style pass, which doesn't render a strip. A theme with artwork
// adds its thumbnail (APPLE_THUMBNAIL_FILES) from its own prefix.
const PASS_TEMPLATE_ASSETS = [
  "icon.png",
  "icon@2x.png",
  "logo.png",
  "logo@2x.png",
];

/**
 * The member's signed `.pkpass`, served from the R2 cache (keyed to
 * `last_updated_at`) when possible; only pays the signing cost on a miss.
 * Drawn in the member's own theme unless `theme` names another.
 */
export async function getApplePassBundle(
  env: Env,
  member: MemberRecord,
  theme: CardTheme = resolveCardTheme(),
): Promise<Uint8Array> {
  const passTypeIdentifier = env.PASSKIT_PASS_TYPE_IDENTIFIER;
  const cached = await getCachedPass(
    env.ASSETS,
    passTypeIdentifier,
    member.member_id,
    member.last_updated_at,
    themeCacheTag(theme),
  );
  if (cached) {
    return cached;
  }

  const assets: Record<string, Uint8Array> = {};
  for (const name of PASS_TEMPLATE_ASSETS) {
    assets[name] = await readTemplateAsset(env, `${theme.assets.applePrefix}${name}`);
  }
  const thumbnailPrefix = theme.artwork.appleThumbnailPrefix;
  if (thumbnailPrefix) {
    for (const name of APPLE_THUMBNAIL_FILES) {
      assets[name] = await readTemplateAsset(env, `${thumbnailPrefix}${name}`);
    }
  }
  const bundle = await assemblePassBundle(
    {
      memberId: member.member_id,
      ...cardName(member),
      status: effectiveStatus(member),
      expirationDate: member.expiration_date,
      memberSince: member.member_since,
      authToken: member.auth_token,
      verifyUrl: await verifyUrl(env, member),
      colors: theme.colors,
    },
    {
      passTypeIdentifier,
      teamIdentifier: env.PASSKIT_TEAM_IDENTIFIER,
      organizationName: env.PASSKIT_ORGANIZATION_NAME,
      webServiceURL: env.PASSKIT_WEB_SERVICE_URL,
      environment: env.ENVIRONMENT,
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
    themeCacheTag(theme),
  );
  return bundle;
}

/**
 * The member's card image (PNG). Uses a dedicated 256px crest rather than the
 * pass icon, which at 58px is too small for the 240px crest on the card.
 * Drawn in the member's own theme unless `theme` names another.
 */
export async function renderCardImage(
  env: Env,
  member: MemberRecord,
  theme: CardTheme = resolveCardTheme(),
): Promise<Uint8Array> {
  // Imported here rather than at the top of the file. This module is imported
  // by nearly everything that touches a member, and the renderer brings satori
  // and resvg with it -- several megabytes of JavaScript that most requests
  // never use. Loaded lazily, their code is evaluated the first time a card is
  // actually drawn. The WebAssembly they use is still compiled at startup:
  // that is a top-level module import in the bundle, and a lazy import of the
  // JavaScript does not move it.
  const { renderMembershipCardPng } = await import("../cardimage/render");
  return renderMembershipCardPng(
    {
      ...cardName(member),
      memberId: member.member_id,
      verifyUrl: await verifyUrl(env, member),
      expirationDate: member.expiration_date,
      memberSince: member.member_since,
    },
    await readTemplateAsset(env, theme.assets.cardCrest),
    theme.colors,
    theme.artwork.cardBackground
      ? await readTemplateAsset(env, theme.artwork.cardBackground)
      : undefined,
  );
}

/**
 * Whether the Google Wallet service-account secrets are set. A type guard, so
 * callers get both values as plain strings once it passes.
 */
/** An `Env` known to carry the Google Wallet service-account secrets. */
export type GoogleWalletConfigured = Env & {
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_WALLET_PRIVATE_KEY_PEM: string;
};

export function isGoogleWalletConfigured(
  env: Env,
): env is GoogleWalletConfigured {
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
async function googleWalletObjectFor(
  env: GoogleWalletConfigured,
  member: MemberRecord,
) {
  const config = googleWalletConfig({
    issuerId: env.GOOGLE_WALLET_ISSUER_ID,
    classSuffix: env.GOOGLE_WALLET_CLASS_SUFFIX,
    baseUrl: env.PUBLIC_BASE_URL,
  });
  const credentials = {
    serviceAccountEmail: env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
    privateKeyPem: env.GOOGLE_WALLET_PRIVATE_KEY_PEM,
  };
  const object = buildGenericObject(
    {
      memberId: member.member_id,
      ...cardName(member),
      status: effectiveStatus(member),
      expirationDate: member.expiration_date,
      memberSince: member.member_since,
      verifyUrl: await verifyUrl(env, member),
    },
    config,
    googleWalletTheme(resolveCardTheme(), env.PUBLIC_BASE_URL),
  );
  return { config, credentials, object };
}

/**
 * Brings Google's copy of a member's pass up to date, for a member who has
 * one. Does nothing for a member who has never saved a pass: see
 * `updateGenericObjectIfPresent`.
 */
export async function refreshGoogleWalletObject(
  env: Env,
  member: MemberRecord,
): Promise<"updated" | "absent" | "not-configured"> {
  if (!isGoogleWalletConfigured(env)) {
    return "not-configured";
  }
  const { credentials, object } = await googleWalletObjectFor(env, member);
  return updateGenericObjectIfPresent(credentials, object);
}

export async function buildGoogleWalletSaveUrl(
  env: Env,
  member: MemberRecord,
): Promise<string> {
  if (!isGoogleWalletConfigured(env)) {
    throw new Error("Google Wallet credentials are not configured");
  }
  const { config, credentials, object } = await googleWalletObjectFor(
    env,
    member,
  );
  // Write the object through the API, then link to it by id: a link
  // carrying the whole object is longer than Google's safe length (#96).
  // This also refreshes Google's copy whenever a link is built.
  await upsertGenericObject(credentials, object);
  const jwt = await signSaveToWalletPayload(
    buildSkinnySaveToWalletPayload(
      object.id,
      config,
      credentials.serviceAccountEmail,
    ),
    credentials,
  );
  return buildSaveToWalletUrl(jwt);
}
