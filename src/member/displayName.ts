/**
 * Setting and clearing the name a member wants on their card (#189).
 *
 * Kept out of `members.first_name`/`last_name` deliberately:
 * `deriveMembershipState()` recomputes those from the member's latest
 * counted order and the upsert writes them unconditionally, so a name stored
 * there would be reverted at their next order sync -- silently, and at a
 * moment nobody is watching.
 */

import type { Env } from "../index";
import { getMemberByEmail } from "./artifacts";
import { actorEmail, recordAuditEvent } from "../audit/log";
import { notifyWalletsUpdated } from "./walletUpdates";

/**
 * Long enough for a name somebody actually uses, short enough that it cannot
 * push everything else off a pass. Nothing else is enforced: a card is a fun
 * vanity item rather than an identity document, and it is fine for one not
 * to show a real name (decided 2026-09-20).
 */
export const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * `legacy_postgres` is written only by the one-time import: the old site let
 * a member change their own name, and those choices had to survive the cutover.
 */
export type DisplayNameSource = "member" | "admin" | "legacy_postgres";

/** What a submitted name becomes, or why it cannot be used. */
export function normalizeDisplayName(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  // Collapse runs of whitespace, including the newlines a paste can carry,
  // so a name cannot smuggle blank lines onto a pass.
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "") {
    return { ok: false, reason: "Enter a name, or clear it to use the name from your orders." };
  }
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      reason: `That is longer than ${MAX_DISPLAY_NAME_LENGTH} characters, which will not fit on a card.`,
    };
  }
  return { ok: true, value };
}

/**
 * Records the name and pushes it to any wallet passes already installed.
 *
 * `members.last_updated_at` is bumped by hand here. It is what Apple's
 * polling endpoint compares against to decide whether a pass has changed,
 * and this name lives in its own table, so nothing else would move it -- the
 * name would change everywhere except on the passes already in people's
 * phones, which is the one place it most needs to.
 */
export async function setDisplayName(
  env: Env,
  email: string,
  displayName: string,
  source: DisplayNameSource,
  note: string | null = null,
  setBy: number | null = null,
): Promise<void> {
  const key = email.trim().toLowerCase();
  // Read before the write, because the row is overwritten in place and this
  // is the only moment the previous name still exists anywhere.
  const previous = await getDisplayName(env, key);
  await env.DB.prepare(
    `INSERT INTO member_display_names (email, display_name, source, note, set_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, unixepoch('subsec') * 1000)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       source = excluded.source,
       note = excluded.note,
       set_by = excluded.set_by,
       updated_at = excluded.updated_at`,
  )
    .bind(key, displayName, source, note, setBy)
    .run();
  await recordAuditEvent(env, {
    action: "display_name.set",
    subjectEmail: key,
    // `legacy_postgres` has no actor: nobody made that decision here.
    actorEmail: source === "legacy_postgres" ? null : await actorEmail(env, setBy),
    detail:
      `"${displayName}"` +
      (previous ? ` (was "${previous.display_name}")` : "") +
      (source === "member" ? ", set by the member themselves" : "") +
      (note ? ` -- ${note}` : ""),
  });
  await touchAndNotify(env, key);
}

/**
 * Removes the override, putting the card back to the name from their orders.
 *
 * `clearedBy` reaches the audit log only: the row goes, so nothing else keeps
 * any account of the name having been there at all.
 */
export async function clearDisplayName(
  env: Env,
  email: string,
  clearedBy: number | null = null,
): Promise<void> {
  const key = email.trim().toLowerCase();
  const previous = await getDisplayName(env, key);
  const result = await env.DB.prepare("DELETE FROM member_display_names WHERE email = ?")
    .bind(key)
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    await recordAuditEvent(env, {
      action: "display_name.cleared",
      subjectEmail: key,
      actorEmail: await actorEmail(env, clearedBy),
      detail: previous ? `Was "${previous.display_name}"` : "Card name cleared",
    });
  }
  await touchAndNotify(env, key);
}

async function touchAndNotify(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE email = ?",
  )
    .bind(email)
    .run();
  const member = await getMemberByEmail(env, email);
  // No row means nobody has a card to update -- an admin can set a name for
  // an address before its first order syncs, and it applies when one does.
  if (member) await notifyWalletsUpdated(env, member.member_id);
}

/**
 * The current override, if any, for showing on a form.
 *
 * `set_by_email` is resolved here rather than by the caller: every screen
 * that shows a name somebody else chose wants to say who, and a user id on
 * its own answers nobody's question. Null where no signed-in person set the
 * name, as with one carried across by the one-time legacy import.
 */
export async function getDisplayName(
  env: Env,
  email: string,
): Promise<{
  display_name: string;
  source: DisplayNameSource;
  set_by_email: string | null;
} | null> {
  return env.DB.prepare(
    `SELECT d.display_name, d.source, u.email AS set_by_email
       FROM member_display_names d
            LEFT JOIN users u ON u.id = d.set_by
      WHERE d.email = ?`,
  )
    .bind(email.trim().toLowerCase())
    .first<{ display_name: string; source: DisplayNameSource; set_by_email: string | null }>();
}
