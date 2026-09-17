/**
 * Fixed-window rate limiting backed by D1 (migration 0006). Cloudflare's
 * built-in Workers Rate Limiting binding only supports 10- or 60-second
 * windows, too short for limits like "3 emails per address per day".
 *
 * Subjects (IP addresses, email addresses) are stored only as SHA-256 hashes.
 * Counting is a single atomic upsert, so concurrent requests can't both slip
 * under the limit. D1 is eventually consistent across replicas, but this
 * project runs a single primary with read replication disabled (terraform).
 */

export interface RateLimitRule {
  /** Namespaces the counter, e.g. `email-card:ip`. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets -- suitable for `Retry-After`. */
  retryAfterSeconds: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Counts one request against `rule` for `subject`, reporting whether it's within the limit. */
export async function consumeRateLimit(
  db: D1Database,
  rule: RateLimitRule,
  subject: string,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart =
    Math.floor(nowSeconds / rule.windowSeconds) * rule.windowSeconds;
  const key = `${rule.name}:${await sha256Hex(subject)}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return {
    allowed: row!.count <= rule.limit,
    retryAfterSeconds: windowStart + rule.windowSeconds - nowSeconds,
  };
}

/** Deletes counters for windows that started more than `maxAgeSeconds` ago. */
export async function purgeExpiredRateLimits(
  db: D1Database,
  maxAgeSeconds: number,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limit_counters WHERE window_start < ?")
    .bind(Math.floor(nowMs / 1000) - maxAgeSeconds)
    .run();
}
