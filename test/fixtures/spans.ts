/**
 * Recording the custom spans (`tracing.enterSpan`) a piece of code opens.
 *
 * Tests run untraced, so the real spans are no-ops that leave nothing to
 * read. This stands in for them: each span's name and attributes are kept,
 * in the order the spans were opened, and the wrapped work runs as before.
 *
 * The runtime opens its own spans the same way (a D1 query is `d1_first`,
 * `d1_all` and so on), so those are recorded too; `named` keeps a test to
 * the spans it is about.
 */

import { tracing } from "cloudflare:workers";
import { vi } from "vitest";

export interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

/** Only the spans called one of `names`, in the order they were opened. */
export function named(spans: RecordedSpan[], ...names: string[]): RecordedSpan[] {
  return spans.filter((span) => names.includes(span.name));
}

export function recordSpans(): RecordedSpan[] {
  const spans: RecordedSpan[] = [];
  vi.spyOn(tracing, "enterSpan").mockImplementation(((
    name: string,
    callback: (span: unknown, ...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => {
    const recorded: RecordedSpan = { name, attributes: {} };
    spans.push(recorded);
    const span = {
      isTraced: false,
      setAttribute(key: string, value: unknown) {
        recorded.attributes[key] = value;
        return span;
      },
      setAttributes(attributes: Record<string, unknown>) {
        Object.assign(recorded.attributes, attributes);
        return span;
      },
      recordException() {},
      end() {},
    };
    return callback(span, ...args);
  }) as typeof tracing.enterSpan);
  return spans;
}
