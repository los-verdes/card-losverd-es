/**
 * Formats an ISO8601 `YYYY-MM-DD` date as e.g. "Feb 17, 2024" -- matches the
 * real example pass's ("lv_apple_pass-hogan.pkpass") "Good through" field.
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
