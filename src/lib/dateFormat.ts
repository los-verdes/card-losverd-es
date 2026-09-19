/**
 * Formats an ISO8601 `YYYY-MM-DD` date as e.g. "Feb 17, 2024" -- matches the
 * "Good through" field on a real pass issued by the legacy production app.
 * Shared by PassKit's and Google Wallet's pass-content generators and the
 * card-image generator, which all show a member's expiration date in this
 * exact format.
 */
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

/**
 * Formats an ISO8601 `YYYY-MM-DD` date as e.g. "Jul 2021" -- matches the
 * real example pass's "Member Since" field. Shared by PassKit's and Google
 * Wallet's pass-content generators.
 */
export function formatMonthYear(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

/**
 * `value` if it is a real `YYYY-MM-DD` date, else null.
 *
 * The round trip is what makes it strict. `Date.parse` accepts `2021-02-30`
 * and quietly rolls it forward to 2 March, so a shaped-but-unreal date would
 * otherwise be accepted and silently become a different day -- which, for a
 * date someone is correcting by hand, is worse than refusing it.
 */
export function parseIsoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}
