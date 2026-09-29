/**
 * The card theme a member has chosen, and the one their card is drawn in
 * (#333, piece 4).
 *
 * A choice is stored apart from the `members` row (`member_card_themes`),
 * like a chosen card name, and for the same reason: the row is rebuilt from
 * the orders on every sync. It is drawn only while the member may still use
 * that theme (src/themes/eligibility.ts); otherwise, and when nobody has
 * chosen, the card is in the member's default. Choosing, changing or
 * clearing a theme is recorded in the audit log and reaches the member's
 * installed passes the way a new card name does.
 *
 * Who may choose is `CARD_THEME_CHOICE`: nobody, admins only (so the picker
 * can be tried on real cards before members see it), or everyone. It governs
 * making a choice, not drawing one already made.
 */

import { actorEmail, recordAuditEvent } from "../audit/log";
import type { Env } from "../index";
import { getMemberByEmail, type MemberRecord } from "../member/artifacts";
import { notifyWalletsUpdated } from "../member/walletUpdates";
import { CARD_THEMES, type CardTheme } from "./cardTheme";
import { getThemeOptions, type ThemeOptions } from "./eligibility";

export type ThemeChoiceSource = "member" | "admin";

export interface ThemeChoice {
  theme_id: string;
  source: ThemeChoiceSource;
  /** The admin or member who chose it, when they still have an account. */
  set_by_email: string | null;
  updated_at: number;
}

/** A theme this member may not use. */
export class ThemeNotAllowed extends Error {}

/** Who may choose a theme, as `CARD_THEME_CHOICE` says. */
export type ThemeChoiceOpenTo = "nobody" | "admins" | "everyone";

/**
 * `CARD_THEME_CHOICE`, read in this one place so that it could move to a flag
 * service without touching its callers. Anything unrecognised is "nobody".
 */
export async function themeChoiceOpenTo(env: Env): Promise<ThemeChoiceOpenTo> {
  const value = env.CARD_THEME_CHOICE?.trim().toLowerCase();
  return value === "admins" || value === "everyone" ? value : "nobody";
}

/** Whether somebody may choose a theme now: everyone, or admins while it is open to them alone. */
export async function mayChooseTheme(env: Env, isAdmin: boolean): Promise<boolean> {
  const openTo = await themeChoiceOpenTo(env);
  return openTo === "everyone" || (openTo === "admins" && isAdmin);
}

export async function getCardThemeChoice(env: Env, email: string): Promise<ThemeChoice | null> {
  return env.DB.prepare(
    `SELECT t.theme_id, t.source, u.email AS set_by_email, t.updated_at
       FROM member_card_themes t LEFT JOIN users u ON u.id = t.set_by
      WHERE t.email = ?`,
  )
    .bind(email.trim().toLowerCase())
    .first<ThemeChoice>();
}

function label(themeId: string, themes: readonly CardTheme[]): string {
  return themes.find((theme) => theme.id === themeId)?.label ?? themeId;
}

/**
 * Records `themeId` as this member's theme. Refuses one they may not use, so
 * a stored choice is always one that was allowed when it was made.
 */
export async function setCardTheme(
  env: Env,
  member: Pick<MemberRecord, "email" | "member_since">,
  themeId: string,
  source: ThemeChoiceSource,
  setBy: number | null,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<void> {
  const options = await getThemeOptions(env, member, themes);
  if (!options.themes.some((theme) => theme.id === themeId)) {
    throw new ThemeNotAllowed(`${member.email} may not use the "${themeId}" theme`);
  }
  const key = member.email.trim().toLowerCase();
  const previous = await getCardThemeChoice(env, key);
  await env.DB.prepare(
    `INSERT INTO member_card_themes (email, theme_id, source, set_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch('subsec') * 1000)
     ON CONFLICT(email) DO UPDATE SET
       theme_id = excluded.theme_id,
       source = excluded.source,
       set_by = excluded.set_by,
       updated_at = excluded.updated_at`,
  )
    .bind(key, themeId, source, setBy)
    .run();
  await recordAuditEvent(env, {
    action: "card_theme.set",
    subjectEmail: key,
    actorEmail: await actorEmail(env, setBy),
    detail:
      `"${label(themeId, themes)}"` +
      (previous ? ` (was "${label(previous.theme_id, themes)}")` : "") +
      (source === "member" ? ", chosen by the member themselves" : ""),
  });
  await touchAndNotify(env, key);
}

/** Removes the choice, putting the card back to the member's default theme. */
export async function clearCardTheme(
  env: Env,
  email: string,
  clearedBy: number | null,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<void> {
  const key = email.trim().toLowerCase();
  const previous = await getCardThemeChoice(env, key);
  const result = await env.DB.prepare("DELETE FROM member_card_themes WHERE email = ?").bind(key).run();
  if ((result.meta.changes ?? 0) > 0) {
    await recordAuditEvent(env, {
      action: "card_theme.cleared",
      subjectEmail: key,
      actorEmail: await actorEmail(env, clearedBy),
      detail: previous ? `Was "${label(previous.theme_id, themes)}"` : "Card theme cleared",
    });
  }
  await touchAndNotify(env, key);
}

/**
 * The theme this member's card is drawn in: their choice while they may still
 * use it, otherwise their default. `member.card_theme` is the choice as the
 * shared member lookup carries it.
 */
export async function resolveCardTheme(
  env: Env,
  member: Pick<MemberRecord, "email" | "member_since" | "card_theme">,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<CardTheme> {
  return effectiveTheme(await getThemeOptions(env, member, themes), member.card_theme);
}

/** The theme drawn, from options already worked out: the choice while it is one of them, else the default. */
export function effectiveTheme(options: ThemeOptions, choice: string | null | undefined): CardTheme {
  return options.themes.find((theme) => theme.id === choice) ?? options.defaultTheme;
}

/**
 * Tells installed passes the card changed. The choice lives outside
 * `members`, so nothing else moves `last_updated_at`, which is what Apple's
 * polling compares against.
 */
async function touchAndNotify(env: Env, email: string): Promise<void> {
  await env.DB.prepare("UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE email = ?")
    .bind(email)
    .run();
  const member = await getMemberByEmail(env, email);
  if (member) await notifyWalletsUpdated(env, member.member_id);
}
