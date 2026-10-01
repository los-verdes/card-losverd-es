/**
 * Moments on the admin pages, written the way a person would say them.
 *
 * In Austin time, since that is where the group and its admins are, with the
 * zone named ("CDT", "CST") so a reading is never ambiguous across the
 * clocks changing. The exact instant, in UTC, is kept in the element's
 * `datetime` and in its tooltip, for anyone matching a time against a log.
 *
 * Downloads are unaffected: CSV files keep the stored ISO values, which
 * spreadsheets sort and parse.
 */

import type { FC } from "hono/jsx";
import { toIsoSeconds } from "../bigcommerce/orders";

export const ADMIN_TIME_ZONE = "America/Chicago";

const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

type Moment = Date | number | string;

/** ICU puts a narrow no-break space before "AM"; a plain one reads and matches the same. */
function plain(text: string): string {
  return text.replace(/[  ]/g, " ");
}

/** "Oct 1, 2026, 9:15 AM CDT". */
export function clockText(at: Moment): string {
  return plain(CLOCK.format(new Date(at)));
}

/** "Oct 1, 2026", the day it was in Austin. */
export function dayText(at: Moment): string {
  return plain(DAY.format(new Date(at)));
}

/** The largest unit that still reads naturally, smallest first. */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60],
  ["hour", 60 * 60],
  ["day", 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["year", 365 * 24 * 60 * 60],
];

/** "just now", "5 minutes ago", "yesterday", "in 3 hours". */
export function agoText(at: Moment, now: number = Date.now()): string {
  const seconds = (new Date(at).getTime() - now) / 1000;
  if (Math.abs(seconds) < 45) return "just now";
  let [unit, size] = UNITS[0];
  for (const [candidate, candidateSize] of UNITS) {
    if (Math.abs(seconds) >= candidateSize * 0.9) [unit, size] = [candidate, candidateSize];
  }
  return RELATIVE.format(Math.round(seconds / size), unit);
}

/**
 * One moment. `ago` leads with how long ago it was, for "when did this last
 * happen" readings such as a sync; tables leave it off, where a column of
 * "3 hours ago" would not compare at a glance.
 */
export const When: FC<{ at: Moment; ago?: boolean }> = ({ at, ago }) => {
  const iso = toIsoSeconds(new Date(at));
  return (
    <time datetime={iso} title={`${iso.replace("T", " ").replace("Z", "")} UTC`}>
      {ago ? `${agoText(at)} (${clockText(at)})` : clockText(at)}
    </time>
  );
};

/** A table cell's sort key for a moment: its ISO form, which sorts as text in time order. */
export function sortKey(at: Moment): string {
  return toIsoSeconds(new Date(at));
}
