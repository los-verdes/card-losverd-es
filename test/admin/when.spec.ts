import { afterEach, describe, expect, it, vi } from "vitest";
import { When, agoText, clockText, dayText, sortKey } from "../../src/admin/when";

const NOW = Date.parse("2026-10-01T12:00:00Z");

describe("clockText", () => {
  it("reads in Austin time, naming the zone either side of the clocks changing", () => {
    expect(clockText("2026-10-01T14:05:00Z")).toBe("Oct 1, 2026, 9:05 AM CDT");
    expect(clockText(Date.parse("2026-01-15T00:30:00Z"))).toBe("Jan 14, 2026, 6:30 PM CST");
  });
});

describe("dayText", () => {
  it("is the day it was in Austin, not in UTC", () => {
    expect(dayText(Date.UTC(2026, 8, 17))).toBe("Sep 16, 2026");
    expect(dayText(Date.UTC(2026, 8, 17, 12))).toBe("Sep 17, 2026");
  });
});

describe("agoText", () => {
  it.each([
    [NOW - 20_000, "just now"],
    [NOW - 5 * 60_000, "5 minutes ago"],
    [NOW - 58 * 60_000, "1 hour ago"],
    [NOW - 11 * 3_600_000 - 20 * 60_000, "11 hours ago"],
    [NOW - 30 * 3_600_000, "yesterday"],
    [NOW - 3 * 86_400_000, "3 days ago"],
    [NOW - 70 * 86_400_000, "2 months ago"],
    [NOW - 800 * 86_400_000, "2 years ago"],
    [NOW + 3 * 3_600_000, "in 3 hours"],
  ])("%s reads as %s", (at, text) => {
    expect(agoText(at, NOW)).toBe(text);
  });
});

describe("When", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the exact instant, in UTC, in the markup and the tooltip", () => {
    expect(String(When({ at: "2026-10-01T14:05:09.123Z" }))).toBe(
      '<time datetime="2026-10-01T14:05:09Z" title="2026-10-01 14:05:09 UTC">Oct 1, 2026, 9:05 AM CDT</time>',
    );
  });

  it("leads with how long ago, when asked", () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });

    expect(String(When({ at: NOW - 2 * 3_600_000, ago: true }))).toContain(">2 hours ago (Oct 1, 2026, 5:00 AM CDT)</time>");
  });
});

describe("sortKey", () => {
  it("is the ISO instant, which sorts as text in time order", () => {
    expect(sortKey(Date.UTC(2023, 10, 14, 22, 13, 20))).toBe("2023-11-14T22:13:20Z");
  });
});
