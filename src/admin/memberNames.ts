/**
 * The name on each member's card, by address, for admin tables that list
 * people by address. An address alone is hard to recognise; the name beside
 * it is what an admin is actually scanning for.
 *
 * Read once per request, however many cells ask: one query over every
 * member (a couple of thousand short rows) rather than one per row. It is
 * read through the request's own context (`contextStorage` in src/index.ts),
 * like the nav's counts, so no page has to thread it through. Outside a
 * request, or if the query fails, there are no names, and the cells show the
 * address alone, as they did before names existed: a table must never fail
 * to load for want of a nicety.
 */

import { tryGetContext } from "hono/context-storage";
import type { Env } from "../index";

/** The card's name: a chosen display name, else the name from their orders. */
const CARD_NAMES_SQL = `
  SELECT m.email,
         COALESCE(d.display_name, TRIM(COALESCE(m.first_name, '') || ' ' || COALESCE(m.last_name, ''))) AS name
    FROM members m
         LEFT JOIN member_display_names d ON d.email = m.email`;

const perRequest = new WeakMap<object, Promise<Map<string, string> | null>>();

export async function loadMemberNames(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare(CARD_NAMES_SQL).all<{ email: string; name: string }>();
  return new Map(results.filter((row) => row.name !== "").map((row) => [row.email, row.name]));
}

/** Every member's card name by address, or null when it can't be had. */
export function memberNames(): Promise<Map<string, string> | null> {
  const c = tryGetContext<{ Bindings: Env }>();
  if (!c?.env?.DB) return Promise.resolve(null);
  let names = perRequest.get(c);
  if (!names) {
    names = loadMemberNames(c.env.DB).catch((error) => {
      console.warn("Admin tables: could not read members' names", error);
      return null;
    });
    perRequest.set(c, names);
  }
  return names;
}
