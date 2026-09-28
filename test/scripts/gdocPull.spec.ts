import { describe, expect, it } from "vitest";
import { applyDocEdits, bannerCommit, join, key, segment } from "../../scripts/lib/gdocPull";

// Inlined at transform time; node:fs is not available in this pool.
const provenance = Object.values(
  import.meta.glob("../../docs/membership-card-provenance.md", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/** A small document in the repository's style. */
const SOURCE = `# Where it comes from

This paragraph is wrapped the way the repository wraps them, with _emphasis_,
\`code\`, a [link to a section](#2-more) and an [outside link](https://example.com/a).

## 1. The short version

* One item.
  * A nested item that runs on long enough to wrap onto a second line in the
    repository.
* Another item, costing $5 + tax.

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\`

| | Apple | Google |
| :--- | :--- | :--- |
| Name | yes | yes |
| Number | back | alt text |

> A quoted note -- with a double hyphen.
`;

/** The same document as Google Docs exports it once the push has put it there. */
const EXPORT = `> **This is a copy, for reading and commenting.** The version lives in the repository.
>
> Taken from commit \`abc1234\` (2026-09-28). Comments here are welcome.

# Where it comes from

This paragraph is wrapped the way the repository wraps them, with *emphasis*, \`code\`, a link to a section and an [outside link](https://example.com/a).

## 1\\. The short version

* One item.
  * A nested item that runs on long enough to wrap onto a second line in the repository.
* Another item, costing $5 \\+ tax.

![Diagram 1][image1]

*Diagram 1, as on [the repository's copy](https://github.com/los-verdes/card-losverd-es/blob/main/docs/membership-card-provenance.md).*

|  | Apple | Google |
| :---- | :---- | :---- |
| Name | yes | yes |
| Number | back | alt text |

> A quoted note — with a double hyphen.

[image1]: <data:image/png;base64,iVBORw0KGgo=>
`;

function edit(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("segment and join", () => {
  it("give back exactly the text they were given", () => {
    for (const text of [SOURCE, provenance, "no trailing newline", "\n\nleading blanks\n\n\n"]) {
      const { units, trailingNewline, trailingBlanks } = segment(text);
      expect(join(units, trailingNewline, trailingBlanks)).toBe(text.split("\r\n").join("\n"));
    }
  });

  it("makes each list item and table row a unit of its own", () => {
    const kinds = segment(SOURCE).units.map((unit) => unit.kind);

    expect(kinds.filter((kind) => kind === "item")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "row")).toHaveLength(4);
  });
});

describe("key", () => {
  it("reads the same for a paragraph however it is wrapped, escaped or emphasised", () => {
    const [ours] = segment("A *thing* costing $5 + tax, per `x` -- see [this](#y).\n").units;
    const [docs] = segment("A _thing_ costing $5 \\+ tax,\nper x — see this.\n").units;

    expect(key(ours)).toBe(key(docs));
  });
});

describe("bannerCommit", () => {
  it("reads the commit the Doc was taken from", () => {
    expect(bannerCommit(EXPORT)).toBe("abc1234");
    expect(bannerCommit("no banner")).toBeNull();
  });
});

describe("applyDocEdits", () => {
  it("changes nothing when the Doc says what the repository said", () => {
    const { markdown, report } = applyDocEdits(SOURCE, EXPORT);

    expect(markdown).toBe(SOURCE);
    expect(report).toEqual({ replaced: 0, added: 0, linksToRestore: [], diagramsKept: 0 });
  });

  it("takes in an edited paragraph, reflowed, and says which link it lost", () => {
    const exported = edit(EXPORT, "wraps them, with *emphasis*", "wraps them, now with *emphasis*");

    const { markdown, report } = applyDocEdits(SOURCE, exported);

    expect(markdown).toContain(
      // Reflowed to 80 columns, a link kept whole on one line.
      "This paragraph is wrapped the way the repository wraps them, now with\n" +
        "_emphasis_, `code`, a link to a section and an\n[outside link](https://example.com/a).\n",
    );
    expect(report.replaced).toBe(1);
    expect(report.linksToRestore).toHaveLength(1);
    // Everything else is the repository's own text, untouched.
    expect(markdown.replace(/This paragraph[^]*?\(https:\/\/example\.com\/a\)\./, "")).toBe(
      SOURCE.replace(/This paragraph[^]*?\(https:\/\/example\.com\/a\)\./, ""),
    );
  });

  it("puts a new list item directly under its neighbour, indented as a continuation", () => {
    const exported = edit(
      EXPORT,
      "* Another item, costing $5 \\+ tax.",
      "* Another item, costing $5 \\+ tax.  \n* A third item added in the Doc, which is long enough that it wraps onto another line.",
    );

    const { markdown } = applyDocEdits(SOURCE, exported);

    expect(markdown).toContain(
      "* Another item, costing $5 + tax.\n* A third item added in the Doc, which is long enough that it wraps onto another\n  line.\n\n```mermaid",
    );
  });

  it("replaces only the table row that changed", () => {
    const { markdown } = applyDocEdits(SOURCE, edit(EXPORT, "| Number | back |", "| Number | on the back |"));

    expect(markdown).toContain("| | Apple | Google |\n| :--- | :--- | :--- |\n| Name | yes | yes |\n| Number | on the back | alt text |");
  });

  it("removes what was deleted in the Doc", () => {
    const { markdown, report } = applyDocEdits(SOURCE, edit(EXPORT, "> A quoted note — with a double hyphen.\n", ""));

    expect(markdown).not.toContain("A quoted note");
    expect(report.replaced).toBe(1);
  });

  it("keeps a diagram the Doc dropped, since a diagram is changed in the repository", () => {
    const { markdown, report } = applyDocEdits(SOURCE, edit(EXPORT, "![Diagram 1][image1]\n", ""));

    expect(markdown).toContain("```mermaid\nflowchart TD\n    A --> B\n```");
    expect(report.diagramsKept).toBe(1);
  });

  it("reads the note the Doc carries in place of a diagram it could not show", () => {
    const exported = edit(
      EXPORT,
      "![Diagram 1][image1]",
      "> **Diagram 1** — this renders on [the repository's copy](https://github.com/los-verdes/card-losverd-es/blob/main/docs/membership-card-provenance.md).",
    );

    expect(applyDocEdits(SOURCE, exported).markdown).toBe(SOURCE);
  });

  it("writes a heading and a quote the way the repository does", () => {
    const exported = edit(edit(EXPORT, "## 1\\. The short version", "## 1\\. The shorter version"), "> A quoted note", "> A longer quoted note, now running well past the width that the repository wraps its lines at, so");

    const { markdown } = applyDocEdits(SOURCE, exported);

    expect(markdown).toContain("## 1. The shorter version\n");
    expect(markdown).toContain(
      "> A longer quoted note, now running well past the width that the repository\n> wraps its lines at, so — with a double hyphen.",
    );
  });

  it("points a link back at the repository file it was made absolute from", () => {
    const exported = edit(EXPORT, "One item.", "One item, see [the README](https://github.com/los-verdes/card-losverd-es/blob/main/README.md).");

    expect(applyDocEdits(SOURCE, exported).markdown).toContain("* One item, see [the README](README.md).");
  });
});
