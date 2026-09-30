/**
 * Which card themes a member may use, and which one their card is drawn in
 * until they choose (#333, piece 3).
 *
 * - A year theme is theirs for each calendar year in which they bought a
 *   membership: the year an order that counts as a membership
 *   (`COUNTS_AS_MEMBERSHIP`) was placed, and only that year, even though the
 *   membership runs on into the next. That matches the membership pack and
 *   scarf, which change every year and come from the year the membership
 *   was bought.
 * - Their "member since" year is always theirs, even when an admin's
 *   correction puts it before their first order.
 * - Classic is always theirs. It is how every card looked before themes, and
 *   the fallback for a year with no theme.
 * - A group theme is theirs while they belong to its subgroup: while the
 *   Slack account with their address is in the subgroup's channel
 *   (src/themes/groups.ts). It is never anyone's default.
 * - Only themes in `CARD_THEMES` are offered, so a year without a published
 *   theme offers nothing extra.
 *
 * The default is classic while `CARD_THEME_YEAR_DEFAULTS` is off. Once it is
 * on, every card whose holder has not chosen -- existing cards and new ones
 * alike -- is drawn in its "member since" year's theme, or classic when that
 * year has none. Turning it on therefore changes cards already on people's
 * phones, which only see the change once their passes are refreshed.
 *
 * Nothing here is remembered. The answer is worked out from the orders each
 * time, so a refund, a re-attributed order or a corrected "member since"
 * changes it at once.
 */

import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";
import type { MemberRecord } from "../member/artifacts";
import { CARD_THEMES, CLASSIC_THEME, type CardTheme } from "./cardTheme";
import { groupsFor } from "./groups";

/** What the answer is worked out from. */
export interface ThemeHistory {
  /** The member's orders that count as a membership; dates begin `YYYY-MM-DD`. */
  orders: ReadonlyArray<{ created_on: string; expires_on: string }>;
  /** Effective "member since" (`YYYY-MM-DD`), or null when there is none. */
  memberSince: string | null;
  /** The subgroups they belong to now (`CardGroup.id`). */
  groups?: ReadonlySet<string>;
}

export interface ThemeOptions {
  /** Classic first, then year themes in year order, then group themes. */
  themes: CardTheme[];
  /** The theme the card is drawn in until its holder chooses; always one of `themes`. */
  defaultTheme: CardTheme;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** Every calendar year in which one of these orders was placed. */
export function purchaseYears(orders: ThemeHistory["orders"]): Set<number> {
  return new Set(orders.map((order) => yearOf(order.created_on)));
}

/**
 * The themes a member may use and their default. `yearDefaults` is whether
 * `CARD_THEME_YEAR_DEFAULTS` is on.
 */
export function themeOptions(
  history: ThemeHistory,
  yearDefaults: boolean,
  themes: readonly CardTheme[] = CARD_THEMES,
): ThemeOptions {
  const years = purchaseYears(history.orders);
  const sinceYear = history.memberSince ? yearOf(history.memberSince) : null;
  if (sinceYear !== null) {
    years.add(sinceYear);
  }

  const yearThemes = themes
    .filter((theme) => theme.year !== undefined && years.has(theme.year))
    .sort((a, b) => a.year! - b.year!);

  const groupThemes = themes.filter((theme) => theme.group !== undefined && history.groups?.has(theme.group));

  const defaultTheme = (yearDefaults && yearThemes.find((theme) => theme.year === sinceYear)) || CLASSIC_THEME;

  return { themes: [CLASSIC_THEME, ...yearThemes, ...groupThemes], defaultTheme };
}

/**
 * Whether cards default to their "member since" year's theme
 * (`CARD_THEME_YEAR_DEFAULTS`). Asynchronous, and the only place that reads
 * the setting, so that it could move to a flag service without touching its
 * callers.
 */
export async function themeYearDefaultsEnabled(env: Env): Promise<boolean> {
  return env.CARD_THEME_YEAR_DEFAULTS?.trim().toLowerCase() === "true";
}

/** The themes this member may use, and their default, from what is on record now. */
export async function getThemeOptions(
  env: Env,
  member: Pick<MemberRecord, "email" | "member_since">,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<ThemeOptions> {
  const { results } = await env.DB.prepare(
    `SELECT created_on, expires_on FROM membership_orders WHERE member_email = ? AND ${COUNTS_AS_MEMBERSHIP}`,
  )
    .bind(member.email)
    .all<{ created_on: string; expires_on: string }>();

  return themeOptions(
    { orders: results, memberSince: member.member_since, groups: await groupsFor(env, member.email) },
    await themeYearDefaultsEnabled(env),
    themes,
  );
}
