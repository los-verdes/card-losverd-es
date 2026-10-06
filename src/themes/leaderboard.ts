/**
 * How many members carry each theme, for the leaderboard on the theme page.
 *
 * Counts current memberships only -- good through today, not revoked, not
 * expelled -- so it describes cards in use rather than every card ever drawn.
 * A member who has not picked a theme counts as "default", whatever their
 * default happens to be. A stored choice of a theme no longer listed is
 * drawn as the default, so it counts as one too. A group theme kept after
 * leaving its subgroup still counts as chosen: telling those apart would mean
 * asking Slack about every member, for a difference of a handful.
 *
 * Counts only, never names: any current member can see it.
 */

import type { Env } from "../index";
import { CARD_THEMES, type CardTheme } from "./cardTheme";

export interface ThemeTally {
  /** The theme, or null for members who have not picked one. */
  theme: CardTheme | null;
  members: number;
}

export interface ThemeLeaderboard {
  /** Every current member, so each tally can be shown as a share. */
  total: number;
  /** Most members first; the default, then themes in their usual order, on a tie. Themes nobody carries are left out. */
  tallies: ThemeTally[];
}

export async function themeLeaderboard(
  env: Env,
  today: string = new Date().toISOString().slice(0, 10),
  themes: readonly CardTheme[] = CARD_THEMES,
): Promise<ThemeLeaderboard> {
  const { results } = await env.DB.prepare(
    `SELECT t.theme_id AS theme_id, COUNT(*) AS members
       FROM members m LEFT JOIN member_card_themes t ON t.email = m.email
      WHERE m.expiration_date >= ?
        AND NOT EXISTS (SELECT 1 FROM revoked_cards r WHERE r.member_id = m.member_id)
        AND NOT EXISTS (SELECT 1 FROM expelled_people e WHERE e.email = m.email)
      GROUP BY t.theme_id`,
  )
    .bind(today)
    .all<{ theme_id: string | null; members: number }>();

  let defaults = 0;
  const chosen = new Map<string, number>();
  for (const row of results) {
    if (row.theme_id !== null && themes.some((theme) => theme.id === row.theme_id)) {
      chosen.set(row.theme_id, row.members);
    } else {
      defaults += row.members;
    }
  }

  const tallies: ThemeTally[] = [
    { theme: null, members: defaults },
    ...themes.map((theme) => ({ theme, members: chosen.get(theme.id) ?? 0 })),
  ].filter((tally) => tally.members > 0);
  // Array.prototype.sort is stable, so ties keep the order built above.
  tallies.sort((a, b) => b.members - a.members);

  return { total: results.reduce((sum, row) => sum + row.members, 0), tallies };
}
