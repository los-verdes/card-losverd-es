/**
 * What phones have been telling us, gathered into something readable (#56).
 *
 * `/passkit/v1/log` is Apple's channel for a device to say a pass would not
 * register or update, and every message lands in `pass_device_logs`. The
 * hourly watch counts them; counting alone was not enough. The one time these
 * mattered -- hundreds of failures from dozens of phones over a week -- the
 * count was never the question. "Which failure, and is it one fault or many?"
 * was, and answering it meant reading raw log lines by hand.
 *
 * So the messages are grouped here by their shape rather than listed. Apple
 * writes one line per attempt, each carrying the serial, the device and the
 * URL it was working on, which makes a thousand identical faults look like a
 * thousand different messages. Masking those out leaves the part that says
 * what went wrong -- and, because a device identifier is personal data we
 * have no reason to show, keeps them off the page at the same time.
 */

import type { Env } from "../index";

/** How far back the page looks. A week covers a fault nobody noticed on the day. */
export const DEVICE_REPORT_WINDOW_DAYS = 7;

/**
 * Raw rows read per request. A busy week could hold far more; the shapes are
 * what matter, and the most recent rows carry them just as well.
 */
export const MAX_DEVICE_REPORT_ROWS = 500;

/** Shapes shown. Beyond a handful it stops being a summary. */
export const MAX_DEVICE_REPORT_GROUPS = 8;

export interface DeviceReportGroup {
  /** The message with its varying parts masked: what these reports have in common. */
  shape: string;
  /** How many messages took this shape in the window. */
  count: number;
  /** When the most recent one arrived. */
  lastSeen: number;
}

/** Long enough for any fault Apple describes; a shape is a heading, not a log line. */
export const MAX_SHAPE_LENGTH = 300;

/**
 * What gets masked, in order. Each is something that varies between two
 * reports of the *same* fault, and nothing here may swallow what tells two
 * faults apart -- which in practice means the status code at the end, so no
 * rule touches a run of three digits.
 *
 * Masking by pattern rather than by taking the tail after "encountered
 * error:". Apple's phrasing is not a promise, and a message that does not
 * follow it still groups sensibly here instead of vanishing.
 */
const MASKS: [RegExp, string][] = [
  // First: a URL can contain anything below, and would be masked to pieces.
  // Stops at ")" because these arrive inside a parenthesised clause.
  [/https?:\/\/[^\s)]+/gi, "<url>"],
  // The date Wallet echoes back when it complains about a conditional
  // request. Every retry carries a different one, and nothing else in the
  // message varies, so without this one fault becomes one row per attempt.
  [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g, "<date>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // A card serial: this site's, or the previous site's rendered as an integer.
  [/\bLV-[0-9a-z-]+/gi, "<id>"],
  // A device identifier is 32 hex characters; a legacy serial is a long run
  // of digits. Sixteen is far above anything meaningful written out in full.
  [/\b[0-9a-f]{16,}\b/gi, "<id>"],
  [/\b\d{5,}\b/g, "<id>"],
];

/**
 * One raw device message, collapsed to the fault it describes: the parts that
 * differ between two phones hitting the same problem are masked, so those two
 * reports land in one row.
 */
export function messageShape(message: string): string {
  const masked = MASKS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
  const tidied = masked.replace(/\s+/g, " ").trim();
  return tidied.length > MAX_SHAPE_LENGTH ? `${tidied.slice(0, MAX_SHAPE_LENGTH)}…` : tidied;
}

/**
 * The window's reports, most common first. Empty when no phone has complained,
 * which is the normal state and what the page should usually say.
 */
export async function recentDeviceReports(env: Env, now: Date = new Date()): Promise<DeviceReportGroup[]> {
  const since = now.getTime() - DEVICE_REPORT_WINDOW_DAYS * 86_400_000;
  const { results } = await env.DB.prepare(
    "SELECT message, logged_at FROM pass_device_logs WHERE logged_at > ? ORDER BY logged_at DESC LIMIT ?",
  )
    .bind(since, MAX_DEVICE_REPORT_ROWS)
    .all<{ message: string; logged_at: number }>();

  const groups = new Map<string, DeviceReportGroup>();
  for (const row of results) {
    const shape = messageShape(row.message);
    const group = groups.get(shape);
    if (group) {
      group.count += 1;
      group.lastSeen = Math.max(group.lastSeen, row.logged_at);
    } else {
      groups.set(shape, { shape, count: 1, lastSeen: row.logged_at });
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, MAX_DEVICE_REPORT_GROUPS);
}
