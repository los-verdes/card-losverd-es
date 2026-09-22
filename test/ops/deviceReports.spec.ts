import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DEVICE_REPORT_GROUPS,
  messageShape,
  recentDeviceReports,
} from "../../src/ops/deviceReports";

const NOW = new Date("2026-09-22T12:00:00Z");
const DAY = 86_400_000;

/** The shape of what Apple sends: one line per attempt, carrying the thing it was working on. */
function registerFailure(serial: string, code: number) {
  return (
    `Register task (for device 0123456789abcdef0123456789abcdef, pass type pass.es.losverd.card, ` +
    `serial number ${serial}; with web service url https://card.losverd.es/passkit) ` +
    `encountered error: Authentication failure (${code})`
  );
}

async function report(message: string, at: Date = NOW) {
  await env.DB.prepare("INSERT INTO pass_device_logs (log_level, message, logged_at) VALUES ('error', ?, ?)")
    .bind(message, at.getTime())
    .run();
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM pass_device_logs");
});

describe("what phones reported", () => {
  it("says nothing when nobody has complained", async () => {
    expect(await recentDeviceReports(env, NOW)).toEqual([]);
  });

  it("gathers the same fault from different passes into one row", async () => {
    await report(registerFailure("111111111111111111111111111111111", 401));
    await report(registerFailure("222222222222222222222222222222222", 401));
    await report(registerFailure("333333333333333333333333333333333", 401));

    const groups = await recentDeviceReports(env, NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });

  it("keeps different faults apart, most common first", async () => {
    await report(registerFailure("111111111111111111111111111111111", 401));
    await report(registerFailure("222222222222222222222222222222222", 401));
    await report("Get pass task encountered error: Unexpected response code 404");

    const groups = await recentDeviceReports(env, NOW);

    expect(groups).toHaveLength(2);
    expect(groups[0].count).toBe(2);
    expect(groups[1].count).toBe(1);
  });

  it("shows no device identifier, which is somebody's phone", async () => {
    await report(registerFailure("111111111111111111111111111111111", 401));

    const [group] = await recentDeviceReports(env, NOW);

    expect(group.shape).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("leaves out what fell outside the window", async () => {
    await report(registerFailure("111111111111111111111111111111111", 401), new Date(NOW.getTime() - 30 * DAY));

    expect(await recentDeviceReports(env, NOW)).toEqual([]);
  });

  it("shows only a summary's worth of shapes", async () => {
    for (let i = 0; i <= MAX_DEVICE_REPORT_GROUPS; i++) {
      await report(`A distinct complaint number ${i}`);
    }

    expect(await recentDeviceReports(env, NOW)).toHaveLength(MAX_DEVICE_REPORT_GROUPS);
  });

  it("carries the most recent time a fault was seen", async () => {
    await report(registerFailure("111111111111111111111111111111111", 401), new Date(NOW.getTime() - 2 * DAY));
    await report(registerFailure("222222222222222222222222222222222", 401), new Date(NOW.getTime() - DAY));

    const [group] = await recentDeviceReports(env, NOW);

    expect(group.lastSeen).toBe(NOW.getTime() - DAY);
  });
});

describe("messageShape", () => {
  it("is stable for the same fault and distinct for a different one", () => {
    expect(messageShape(registerFailure("1111111111111111111111", 401))).toBe(
      messageShape(registerFailure("9999999999999999999999", 401)),
    );
    expect(messageShape(registerFailure("1111111111111111111111", 401))).not.toBe(
      messageShape(registerFailure("1111111111111111111111", 404)),
    );
  });

  it("gathers the conditional-request complaint, which carries a different date every time", () => {
    // Seen on staging: every retry echoes back its own Last-Modified, so
    // without masking the date one fault becomes one row per attempt.
    const complaint = (date: string) =>
      `Server ignored the if-modified-since header (${date}), returned the full unchanged pass data`;

    expect(messageShape(complaint("Mon, 21 Sep 2026 21:00:53 GMT"))).toBe(
      messageShape(complaint("Tue, 22 Sep 2026 09:14:02 GMT")),
    );
  });

  it("masks a legacy card serial and the URL it was working on", () => {
    const shape = messageShape(
      "Get pass task (serial number 17123456789012345678901234567890123456789; " +
        "with web service url https://card.losverd.es/passkit) encountered error: 401",
    );

    expect(shape).toBe("Get pass task (serial number <id>; with web service url <url>) encountered error: 401");
  });

  it("keeps a message that follows no known phrasing rather than dropping it", () => {
    expect(messageShape("Something nobody has seen before")).toBe("Something nobody has seen before");
  });
});
