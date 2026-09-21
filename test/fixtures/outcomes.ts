/**
 * Reading back the outcome lines (src/lib/outcome.ts) a request logged.
 *
 * Every read also checks the one rule outcomes must keep: nothing in them
 * identifies a person. An `@` is the cheapest sign an address got in, so any
 * spec that looks at outcomes enforces that for free.
 */

import { expect, vi, type MockInstance } from "vitest";

export function spyOnOutcomes(): MockInstance<(...args: unknown[]) => void> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

export function outcomesFrom(spy: MockInstance<(...args: unknown[]) => void>): Record<string, unknown>[] {
  const lines = spy.mock.calls
    .map(([first]) => first)
    .filter((first): first is Record<string, unknown> => typeof first === "object" && first !== null && "outcome" in first);
  expect(JSON.stringify(lines), "an outcome line must never carry an address").not.toContain("@");
  return lines;
}
