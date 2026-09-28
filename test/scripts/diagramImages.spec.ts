import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { diagramImageUrls, mermaidPngUrl, replaceDiagrams } from "../../scripts/lib/diagramImages";

// Inlined at transform time; node:fs is not available in this pool.
const provenance = Object.values(
  import.meta.glob("../../docs/membership-card-provenance.md", { query: "?raw", import: "default", eager: true }),
)[0] as string;

const FLOWCHART = 'flowchart TD\n    A["Order<br/>webhook"] --> B{"Counts?"}';

function decode(url: string): string {
  const encoded = url.slice(url.lastIndexOf("/") + 1);
  return Buffer.from(inflateSync(Buffer.from(encoded, "base64url"))).toString("utf8");
}

describe("mermaidPngUrl", () => {
  it("encodes the diagram into a Kroki PNG URL that decodes back to it exactly", () => {
    const url = mermaidPngUrl(FLOWCHART);

    expect(url).toMatch(/^https:\/\/kroki\.io\/mermaid\/png\/[A-Za-z0-9_-]+$/);
    expect(decode(url)).toBe(FLOWCHART);
  });

  it("keeps characters outside ASCII intact", () => {
    expect(decode(mermaidPngUrl("A --> B[\"Año — ✓\"]"))).toBe("A --> B[\"Año — ✓\"]");
  });

  it("can point at another Kroki", () => {
    expect(mermaidPngUrl(FLOWCHART, "http://localhost:8000")).toMatch(/^http:\/\/localhost:8000\/mermaid\/png\//);
  });
});

describe("replaceDiagrams", () => {
  it("replaces each diagram in order, numbering them, and leaves other code alone", () => {
    const md = "# Doc\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\ntext\n\n```js\nx\n```\n\n```mermaid\nflowchart LR\n  C --> D\n```\n";

    const { markdown, diagrams } = replaceDiagrams(md, ({ number }) => `[diagram ${number}]`);

    expect(markdown).toBe("# Doc\n\n[diagram 1]\n\ntext\n\n```js\nx\n```\n\n[diagram 2]\n");
    expect(diagrams).toEqual([
      { number: 1, source: "flowchart TD\n  A --> B" },
      { number: 2, source: "flowchart LR\n  C --> D" },
    ]);
  });

  it("finds every diagram in the provenance document", () => {
    const expected = provenance.split("```mermaid").length - 1;

    const { diagrams } = replaceDiagrams(provenance.split("\r\n").join("\n"), () => "");

    expect(expected).toBeGreaterThan(0);
    expect(diagrams).toHaveLength(expected);
  });
});

describe("diagramImageUrls", () => {
  it("lists the image each diagram became, and nothing else", () => {
    const url = mermaidPngUrl(FLOWCHART);
    const md = `![Diagram 1](${url})\n\n![a photo](https://example.com/p.png)\n\n![Diagram 2](${url}2)`;

    expect(diagramImageUrls(md)).toEqual([url, `${url}2`]);
  });
});
