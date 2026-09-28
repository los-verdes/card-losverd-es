import { describe, expect, it } from "vitest";

// Inlined at transform time; node:fs is not available in this pool.
const wranglerToml = Object.values(
  import.meta.glob("../wrangler.toml", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/** The lines of one `[table]`, up to the next table header. */
function table(name: string): string[] {
  const lines = wranglerToml.split("\n");
  const start = lines.indexOf(`[${name}]`);
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("["));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

describe("Workers Logs and traces", () => {
  it("leave query strings out, since admin searches carry members' addresses there", () => {
    expect(table("observability")).toContain("redact_query_string = true");
  });

  it("are configured once, so staging inherits the redaction rather than overriding it", () => {
    expect(wranglerToml).not.toMatch(/^\[env\.[^\]]+\.observability/m);
  });
});
