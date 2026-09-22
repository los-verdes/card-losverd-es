import { describe, expect, it } from "vitest";
import { tickStep, ticks } from "../../src/admin/monthChart";

// Properties rather than exact steps: which "round" numbers the axis uses is
// a matter of taste, but every one of these has to hold whatever it is.
describe("the orders-by-month chart's axis", () => {
  it.each([0, 1, 2, 3, 7, 9, 10, 11, 23, 48, 99, 100, 101, 137, 480, 1234])(
    "labels a tallest bar of %i sensibly",
    (max) => {
      const step = tickStep(max);
      const lines = ticks(max);

      expect(Number.isInteger(step)).toBe(true);
      expect(step).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toBe(0);
      expect(lines[lines.length - 1]).toBeGreaterThanOrEqual(max);
      // No more than one step of headroom above the tallest bar.
      expect(lines[lines.length - 1] - step).toBeLessThan(Math.max(max, 1));
      // Enough gridlines to read a value off, few enough to stay a chart.
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(11);
    },
  );

  it("draws a chart for a year with no orders at all, rather than dividing by zero", () => {
    expect(ticks(0)).toEqual([0, 1]);
  });
});
