/**
 * Links an OAuth login to a `users` row (the migration plan's Phase 2.3.2),
 * replacing python-social-auth's `UserSocialAuth` table and pipeline. Called
 * once per OAuth sign-in, from Auth.js's `jwt` callback (src/auth/authjs.ts).
 */

import type { Env } from "../index";

export interface OAuthLogin {
  provider: string;
  /** The provider's stable subject id (OIDC `sub`). */
  providerUserId: string;
  /** Provider-verified (enforced by Auth.js's `signIn` callback). */
  email: string;
  fullName: string | null;
}

/**
 * An already-linked identity wins. Otherwise the identity is linked to the
 * user with the same email -- the legacy `associate_by_email` behavior, so
 * the same person logging in with Google today and Apple next year lands on
 * one account -- creating that user first if needed. `full_name` only fills
 * in a newly created user.
 */
export async function linkOAuthUser(
  env: Env,
  login: OAuthLogin,
): Promise<{ id: number; is_admin: number }> {
  const linked = await env.DB.prepare(
    `SELECT u.id, u.is_admin FROM oauth_identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.provider = ? AND i.provider_user_id = ?`,
  )
    .bind(login.provider, login.providerUserId)
    .first<{ id: number; is_admin: number }>();
  if (linked) {
    return linked;
  }

  const email = login.email.toLowerCase();
  // `DO UPDATE` (rather than `DO NOTHING`) is what makes `RETURNING` yield
  // the existing row on an email match. It also fills in the name of a row
  // an admin grant created before this person had ever signed in
  // (src/admin/adminAccess.ts), without overwriting one already there.
  const user = (await env.DB.prepare(
    `INSERT INTO users (email, full_name) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET full_name = COALESCE(users.full_name, excluded.full_name)
     RETURNING id, is_admin`,
  )
    .bind(email, login.fullName)
    .first<{ id: number; is_admin: number }>())!;
  // `DO NOTHING` covers two concurrent first logins for the same identity.
  await env.DB.prepare(
    `INSERT INTO oauth_identities (user_id, provider, provider_user_id, email_at_link_time)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO NOTHING`,
  )
    .bind(user.id, login.provider, login.providerUserId, email)
    .run();
  return user;
}
