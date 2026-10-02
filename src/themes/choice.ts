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
 *
 * An admin's choice on somebody's behalf goes in the audit log; a member's
 * choice for their own card does not. It is theirs to make and to change as
 * often as they like, and the stored choice already says who made it.
 */
export async function setCardTheme(
  env: Env,
  member: Pick<MemberRecord, "email" | "member_since">,
  themeId: string,
  source: ThemeChoiceSource,
  setBy: number | null,
  themes: readonly CardTheme[] = CARD_THEMES,
  defer?: Defer,
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
  if (source === "admin") {
    await recordAuditEvent(env, {
      action: "card_theme.set",
      subjectEmail: key,
      actorEmail: await actorEmail(env, setBy),
      detail: `"${label(themeId, themes)}"` + (previous ? ` (was "${label(previous.theme_id, themes)}")` : ""),
    });
  }
  await touchAndNotify(env, key, defer);
}

/**
 * Removes the choice, putting the card back to the member's default theme.
 * Recorded in the audit log when an admin clears it, as with `setCardTheme`.
 */
export async function clearCardTheme(
  env: Env,
  email: string,
  source: ThemeChoiceSource,
  clearedBy: number | null,
  themes: readonly CardTheme[] = CARD_THEMES,
  defer?: Defer,
): Promise<void> {
  const key = email.trim().toLowerCase();
  const previous = await getCardThemeChoice(env, key);
  const result = await env.DB.prepare("DELETE FROM member_card_themes WHERE email = ?").bind(key).run();
  if (source === "admin" && (result.meta.changes ?? 0) > 0) {
    await recordAuditEvent(env, {
      action: "card_theme.cleared",
      subjectEmail: key,
      actorEmail: await actorEmail(env, clearedBy),
      detail: previous ? `Was "${label(previous.theme_id, themes)}"` : "Card theme cleared",
    });
  }
  await touchAndNotify(env, key, defer);
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
 * Hands work to the runtime to finish after the response (`waitUntil`), so a
 * member is not kept waiting on it.
 */
export type Defer = (work: Promise<unknown>) => void;

/**
 * Tells installed passes the card changed. The choice lives outside
 * `members`, so nothing else moves `last_updated_at`, which is what Apple's
 * polling compares against. Also used when a card's theme changes without a
 * choice changing: somebody leaving the subgroup whose theme they had chosen
 * (src/slack/channelMembers.ts).
 *
 * The record is touched before returning; telling the passes, an APNs push
 * and a call to Google that took over two seconds of a member's save
 * (2026-10-02), is left to `defer` when given one.
 */
export async function touchAndNotify(env: Env, email: string, defer?: Defer): Promise<void> {
  await env.DB.prepare("UPDATE members SET last_updated_at = unixepoch('subsec') * 1000 WHERE email = ?")
    .bind(email)
    .run();
  const member = await getMemberByEmail(env, email);
  if (!member) return;
  const notify = notifyWalletsUpdated(env, member.member_id);
  if (defer) defer(notify.catch((error) => console.error("Telling passes of a theme change failed", { error: String(error) })));
  else await notify;
}
