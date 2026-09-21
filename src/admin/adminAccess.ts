/**
 * Who is an admin, and changing that from the admin pages.
 *
 * Admin is `users.is_admin`, read from D1 on every admin request, so a change
 * here takes effect on the person's next page load. A grant creates the
 * `users` row if the person has never signed in: their first sign-in links to
 * it by address (src/auth/oauth-link.ts) and keeps the flag, so a group of
 * people can be set up at once rather than one at a time as each signs in.
 * It has to be the address they will sign in with -- an Apple Hide My Email
 * relay address, for someone who uses one.
 *
 * `scripts/admin.mjs` (`just admin-grant` / `admin-revoke`) does the same
 * from a terminal, straight against D1. That is the way back in when nobody
 * can reach these pages, which is also why this page will not let an admin
 * revoke themselves: the last admin locking everyone out should take a
 * deliberate trip to the command line, not one click.
 */

import { actorEmail, recordAuditEvent } from "../audit/log";
import type { Env } from "../index";

export interface Admin {
  id: number;
  email: string;
  full_name: string | null;
  /** Whether they have ever signed in; a grant can come first. */
  signed_in: number;
}

export async function listAdmins(env: Env): Promise<Admin[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.full_name,
            EXISTS (SELECT 1 FROM oauth_identities i WHERE i.user_id = u.id) AS signed_in
       FROM users u
      WHERE u.is_admin = 1
      ORDER BY u.email`,
  ).all<Admin>();
  return results;
}

/** `already`, or whether granting also had to create their account. */
export type GrantOutcome = "granted" | "granted-before-sign-in" | "already";

export async function grantAdmin(env: Env, email: string, grantedBy: number | null): Promise<GrantOutcome> {
  const key = email.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT is_admin FROM users WHERE email = ?")
    .bind(key)
    .first<{ is_admin: number }>();
  if (existing?.is_admin === 1) return "already";

  await env.DB.prepare(
    `INSERT INTO users (email, is_admin) VALUES (?, 1)
     ON CONFLICT(email) DO UPDATE SET is_admin = 1, updated_at = unixepoch('subsec') * 1000`,
  )
    .bind(key)
    .run();
  const outcome: GrantOutcome = existing ? "granted" : "granted-before-sign-in";
  await recordAuditEvent(env, {
    action: "admin.granted",
    subjectEmail: key,
    actorEmail: await actorEmail(env, grantedBy),
    detail:
      outcome === "granted"
        ? "From the admin page."
        : "From the admin page, before they had signed in; it applies when they first do.",
  });
  return outcome;
}

/** False when they were not an admin to begin with. */
export async function revokeAdmin(env: Env, email: string, revokedBy: number | null): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const result = await env.DB.prepare(
    `UPDATE users SET is_admin = 0, updated_at = unixepoch('subsec') * 1000
      WHERE email = ? AND is_admin = 1`,
  )
    .bind(key)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "admin.revoked",
    subjectEmail: key,
    actorEmail: await actorEmail(env, revokedBy),
    detail: "From the admin page.",
  });
  return true;
}

/** Addresses from a pasted list: commas, semicolons, spaces or new lines between them. */
export function parseAddressList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}
