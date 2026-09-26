/**
 * Which card themes a member may use, and which one their card starts in
 * (#333, piece 3).
 *
 * - A year theme is theirs for every calendar year in which they held an
 *   active membership: any year an order that counts as a membership
 *   (`COUNTS_AS_MEMBERSHIP`) was in force, from the day it was placed through
 *   the day it expired, the same "good through" the card shows. A membership
 *   bought in the middle of one year therefore covers the next as well.
 * - Their "member since" year is always theirs, even when an admin's
 *   correction puts it before their first order: it is where a new card
 *   starts.
 * - Classic is always theirs. It is how every card looked before themes, and
 *   the fallback for a year with no theme.
 * - Only themes in `CARD_THEMES` are offered, so a year without a published
 *   theme offers nothing extra.
 *
 * A card starts in classic, unless it was created on or after
 * `CARD_THEME_DEFAULTS_SINCE`: then it starts in its "member since" year's
 * theme, when there is one. Cards that existed before that date keep the look
 * their holders already know until they choose otherwise.
 *
 * Nothing here is remembered. The answer is worked out from the orders each
 * time, so a refund, a re-attributed order or a corrected "member since"
 * changes it at once.
 */

import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";
import type { MemberRecord } from "../member/artifacts";
import { CARD_THEMES, CLASSIC_THEME, type CardTheme } from "./cardTheme";

/** What the answer is worked out from. */
export interface ThemeHistory {
  /** The member's orders that count as a membership; dates begin `YYYY-MM-DD`. */
  orders: ReadonlyArray<{ created_on: string; expires_on: string }>;
  /** Effective "member since" (`YYYY-MM-DD`), or null when there is none. */
  memberSince: string | null;
  /** When the member's card was created (`members.created_at`), epoch ms. */
  cardCreatedAt: number;
}

export interface ThemeOptions {
  /** Classic first, then year themes in year order. */
  themes: CardTheme[];
  /** The theme the card is drawn in until its holder chooses; always one of `themes`. */
  defaultTheme: CardTheme;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** Every calendar year in which one of these orders was in force. */
export function membershipYears(orders: ThemeHistory["orders"]): Set<number> {
  const years = new Set<number>();
  for (const order of orders) {
    for (let year = yearOf(order.created_on); year <= yearOf(order.expires_on); year++) {
      years.add(year);
    }
  }
  return years;
}

/**
 * The themes a member may use and their default. `defaultsSince` is
 * `CARD_THEME_DEFAULTS_SINCE` as epoch ms, or null while it is unset.
 */
export function themeOptions(
  history: ThemeHistory,
  defaultsSince: number | null,
  themes: readonly CardTheme[] = CARD_THEMES,
): ThemeOptions {
  const years = membershipYears(history.orders);
  const sinceYear = history.memberSince ? yearOf(history.memberSince) : null;
  if (sinceYear !== null) {
    years.add(sinceYear);
  }

  const yearThemes = themes
    .filter((theme) => theme.year !== undefined && years.has(theme.year))
    .sort((a, b) => a.year! - b.year!);

  const startsInYearTheme = defaultsSince !== null && history.cardCreatedAt >= defaultsSince;
  const defaultTheme =
    (startsInYearTheme && yearThemes.find((theme) => theme.year === sinceYear)) || CLASSIC_THEME;

  return { themes: [CLASSIC_THEME, ...yearThemes], defaultTheme };
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `CARD_THEME_DEFAULTS_SINCE` as epoch ms. Unset or empty is null, so every
 * card starts in classic; so is a value that is not a date, which is also
 * logged, since that is a mistake rather than a choice.
 */
export function themeDefaultsSince(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = DATE_SHAPE.test(trimmed) ? Date.parse(`${trimmed}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed)) {
    console.error("Card themes: CARD_THEME_DEFAULTS_SINCE is not a YYYY-MM-DD date, starting every card in classic", {
      value: trimmed,
    });
    return null;
  }
  return parsed;
}

/** The themes this member may use, and their default, from what is on record now. */
export async function getThemeOptions(
  env: Env,
  member: Pick<MemberRecord, "member_id" | "member_since">,
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<ThemeOptions> {
  // One row per counting order, or a single row of NULLs for a member with
  // none; either way the card's creation time comes along.
  const { results } = await env.DB.prepare(
    `SELECT m.created_at, o.created_on, o.expires_on
       FROM members m
       LEFT JOIN membership_orders o ON o.member_email = m.email AND ${COUNTS_AS_MEMBERSHIP}
      WHERE m.member_id = ?`,
  )
    .bind(member.member_id)
    .all<{ created_at: number; created_on: string | null; expires_on: string | null }>();

  if (results.length === 0) {
    throw new Error(`No member ${member.member_id}`);
  }
  const orders = results.flatMap((row) =>
    row.created_on && row.expires_on ? [{ created_on: row.created_on, expires_on: row.expires_on }] : [],
  );
  return themeOptions(
    { orders, memberSince: member.member_since, cardCreatedAt: results[0].created_at },
    themeDefaultsSince(env.CARD_THEME_DEFAULTS_SINCE),
    themes,
  );
}
