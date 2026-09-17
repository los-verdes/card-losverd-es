import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { consumeRateLimit, purgeExpiredRateLimits } from "../../src/lib/rateLimit";

const RULE = { name: "test:limit", limit: 2, windowSeconds: 3600 };
const T0 = 1_800_000_000_000; // exactly on an hour boundary (1_800_000_000 s is divisible by 3600)

afterEach(async () => {
  await env.DB.exec("DELETE FROM rate_limit_counters");
});

describe("consumeRateLimit", () => {
  it("allows up to the limit within a window, then blocks", async () => {
    expect((await consumeRateLimit(env.DB, RULE, "203.0.113.7", T0)).allowed).toBe(true);
    expect((await consumeRateLimit(env.DB, RULE, "203.0.113.7", T0 + 1000)).allowed).toBe(true);
    expect((await consumeRateLimit(env.DB, RULE, "203.0.113.7", T0 + 2000)).allowed).toBe(false);
  });

  it("reports seconds until the window resets", async () => {
    const result = await consumeRateLimit(env.DB, RULE, "a", T0 + 600_000); // 10 minutes in
    expect(result.retryAfterSeconds).toBe(3000);
  });

  it("starts a fresh count in the next window", async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(env.DB, RULE, "a", T0);
    expect((await consumeRateLimit(env.DB, RULE, "a", T0 + 3_600_000)).allowed).toBe(true);
  });

  it("counts subjects and rules independently", async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(env.DB, RULE, "a", T0);
    expect((await consumeRateLimit(env.DB, RULE, "b", T0)).allowed).toBe(true);
    expect((await consumeRateLimit(env.DB, { ...RULE, name: "other" }, "a", T0)).allowed).toBe(true);
  });

  it("stores only a hash of the subject", async () => {
    await consumeRateLimit(env.DB, RULE, "jane@example.com", T0);
    const row = await env.DB.prepare("SELECT key FROM rate_limit_counters").first<{ key: string }>();
    expect(row!.key).toMatch(/^test:limit:[0-9a-f]{64}$/);
    expect(row!.key).not.toContain("jane");
  });

  it("defaults to the current time", async () => {
    expect((await consumeRateLimit(env.DB, RULE, "a")).allowed).toBe(true);
  });
});

describe("purgeExpiredRateLimits", () => {
  it("deletes only windows older than the max age", async () => {
    await consumeRateLimit(env.DB, RULE, "old", T0 - 3 * 86_400_000);
    await consumeRateLimit(env.DB, RULE, "recent", T0);

    await purgeExpiredRateLimits(env.DB, 2 * 86_400, T0);

    const { results } = await env.DB.prepare("SELECT window_start FROM rate_limit_counters").all();
    expect(results).toEqual([{ window_start: T0 / 1000 }]);
  });

  it("defaults to the current time", async () => {
    await consumeRateLimit(env.DB, RULE, "a", Date.now() - 10 * 86_400_000);
    await purgeExpiredRateLimits(env.DB, 86_400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limit_counters").first()).toEqual({ n: 0 });
  });
});
