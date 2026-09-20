/**
 * Setting and clearing the name a member wants on their card (#189,
 * migration 0014).
 *
 * Kept out of `members.first_name`/`last_name` deliberately:
 * `deriveMembershipState()` recomputes those from the member's latest
 * counted order and the upsert writes them unconditionally, so a name stored
 * there would be reverted at their next order sync -- silently, and at a
 * moment nobody is watching.
 */

import type { Env } from "../index";
import { getMemberByEmail } from "./artifacts";
import { notifyWalletsUpdated } from "./walletUpdates";

/**
 * Long enough for a name somebody actually uses, short enough that it cannot
 * push everything else off a pass. Nothing else is enforced: a card is a fun
 * vanity item rather than an identity document, and it is fine for one not
 * to show a real name (decided 2026-09-20).
 */
export const MAX_DISPLAY_NAME_LENGTH = 64;

export type DisplayNameSource = "member" | "admin";

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
): Promise<void> {
  const key = email.trim().toLowerCase();
  await env.DB.prepare(
    `INSERT INTO member_display_names (email, display_name, source, note, updated_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch('subsec') * 1000)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       source = excluded.source,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  )
    .bind(key, displayName, source, note)
    .run();
  await touchAndNotify(env, key);
}

/** Removes the override, putting the card back to the name from their orders. */
export async function clearDisplayName(env: Env, email: string): Promise<void> {
  const key = email.trim().toLowerCase();
  await env.DB.prepare("DELETE FROM member_display_names WHERE email = ?")
    .bind(key)
    .run();
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

/** The current override, if any, for showing on a form. */
export async function getDisplayName(
  env: Env,
  email: string,
): Promise<{ display_name: string; source: DisplayNameSource } | null> {
  return env.DB.prepare(
    "SELECT display_name, source FROM member_display_names WHERE email = ?",
  )
    .bind(email.trim().toLowerCase())
    .first<{ display_name: string; source: DisplayNameSource }>();
}
