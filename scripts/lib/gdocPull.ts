/**
 * Brings edits made in the provenance document's Google Doc copy back into
 * the repository's Markdown (scripts/provenance-gdoc-pull.mjs).
 *
 * Google Docs exports Markdown, but not ours: every paragraph on one line,
 * list items ending in hard breaks, punctuation backslash-escaped, `*` for
 * emphasis, internal links flattened to their text (scripts/provenance-gdoc.mjs
 * did that on the way out), and the diagrams as embedded images. Writing that
 * over the repository's file would change nearly every line and hide the
 * few that somebody actually edited.
 *
 * So the comparison is made unit by unit -- a paragraph, a list item, a
 * heading, a table, a code block -- on a normalised form that ignores all of
 * the above. Units that compare equal keep the repository's text exactly,
 * links and wrapping included. Only units somebody changed in the Doc are
 * taken from it, reflowed to the repository's style. The comparison is made
 * against the commit the Doc was taken from (its banner names it), so the
 * result is that commit plus the Doc's edits, ready to merge into whatever
 * the repository holds now.
 */

/** A table is one unit per row, so an edited cell replaces only its row. */
export type UnitKind = "paragraph" | "item" | "heading" | "row" | "code" | "quote";

export interface Unit {
  kind: UnitKind;
  /** Exactly as written, without the blank lines around it. */
  raw: string;
  /** Blank lines between this unit and the one before it. */
  blankBefore: number;
}

const FENCE = /^\s*```/;
const LIST_MARKER = /^(\s*)([*+-]|\d+[.)]|\d+\\\.)\s+/;

/** The document as a list of units, which `join` turns back into exactly the same text. */
export function segment(markdown: string): { units: Unit[]; trailingNewline: boolean; trailingBlanks: number } {
  const lines = markdown.split("\r\n").join("\n").split("\n");
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  const units: Unit[] = [];
  // Cast rather than annotated: TypeScript would otherwise narrow it to `null`
  // for good, not seeing the closures below reassign it.
  let current = null as { kind: UnitKind; lines: string[] } | null;
  let blanks = 0;
  const flush = () => {
    if (current) units.push({ kind: current.kind, raw: current.lines.join("\n"), blankBefore: blanks });
    if (current) blanks = 0;
    current = null;
  };
  const start = (kind: UnitKind, line: string) => {
    flush();
    current = { kind, lines: [line] };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      start("code", line);
      while (++i < lines.length) {
        current!.lines.push(lines[i]);
        if (FENCE.test(lines[i])) break;
      }
      flush();
    } else if (/^\s*$/.test(line)) {
      flush();
      blanks++;
    } else if (/^#{1,6}\s/.test(line)) {
      start("heading", line);
      flush();
    } else if (/^\s*\|/.test(line)) {
      start("row", line);
    } else if (LIST_MARKER.test(line)) {
      start("item", line);
    } else if (/^\s*>/.test(line)) {
      if (current?.kind === "quote") current.lines.push(line);
      else start("quote", line);
    } else if (current && (current.kind === "paragraph" || current.kind === "item" || current.kind === "quote")) {
      current.lines.push(line);
    } else {
      start("paragraph", line);
    }
  }
  flush();
  return { units, trailingNewline, trailingBlanks: blanks };
}

export function join(units: Unit[], trailingNewline: boolean, trailingBlanks = 0): string {
  const text = units.map((unit, i) => "\n".repeat(i === 0 ? unit.blankBefore : 1 + unit.blankBefore) + unit.raw).join("");
  return text + "\n".repeat(trailingBlanks) + (trailingNewline ? "\n" : "");
}

const DIAGRAM = "\u0000diagram";
const DROP = "\u0000drop";

/** Undoes Google Docs' backslash escapes. */
function unescapeDocs(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!<>|~=])/g, "$1");
}

/**
 * What a unit says, for comparison: its words, without the formatting that
 * differs between the repository's Markdown and Google Docs' export.
 */
export function key(unit: Unit): string {
  if (unit.kind === "code") return /^\s*```mermaid/.test(unit.raw) ? DIAGRAM : `\u0000code:${unit.raw.trim()}`;
  // How the Doc carries a diagram: its image, a caption under it, the image
  // data itself at the end, or -- when the images could not be had -- a note.
  if (/^!\[Diagram \d+\]/.test(unit.raw)) return DIAGRAM;
  if (/^>\s*\*\*Diagram \d+\*\* — this renders/.test(unit.raw)) return DIAGRAM;
  if (/^[*_]Diagram \d+, as on /.test(unit.raw)) return DROP;
  if (/^\[image\d+\]:\s*<?data:/.test(unit.raw)) return DROP;

  let text = unit.raw.replace(/^\s*>\s?/gm, "");
  if (unit.kind === "item") text = text.replace(LIST_MARKER, "");
  if (unit.kind === "heading") text = text.replace(/^#+\s*/, "");
  if (unit.kind === "row") {
    if (/^\s*\|?(\s*:?-{3,}:?\s*\|?)+\s*$/.test(text)) return "\u0000rule";
    text = text.replaceAll("|", " ");
  }
  text = unescapeDocs(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/—|–|--/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

const WIDTH = 80;

function wrap(text: string, first: string, rest: string): string {
  // A link stays on one line, however many words its text has.
  const words = text.match(/!?\[[^\]]*\]\([^)\s]*\)\S*|\S+/g) ?? [];
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of words) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (empty ? "" : " ") + word;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}

/** A unit from the Doc, written the way the repository writes it. */
export function toRepositoryStyle(unit: Unit): string {
  const lines = unit.raw
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .map((line) => line.replace(/\]\(https:\/\/github\.com\/los-verdes\/card-losverd-es\/blob\/main\/([^)]+)\)/g, "]($1)"));
  // Undo only the escapes Google Docs adds before characters that need none
  // mid-sentence; a heading's "1\." and a list's "1\." are handled with them.
  // Italics as the repository writes them; bold (`**`) is the same in both.
  const clean = (text: string) =>
    unescapeDocs(text).replace(/(?<![*\w])\*(?!\*)([^*\n]*?[^*\s])\*(?![*\w])/g, "_$1_");
  if (unit.kind === "code") return lines.join("\n");
  if (unit.kind === "row") return clean(lines.join(" ")).replace(/\|\s{2,}\|/g, "| |");
  if (unit.kind === "heading") return clean(lines.join(" "));
  if (unit.kind === "quote") {
    return wrap(clean(lines.map((line) => line.replace(/^\s*>\s?/, "")).join(" ")), "> ", "> ");
  }
  if (unit.kind === "item") {
    const [, indent, marker] = lines[0].match(LIST_MARKER)!;
    const bullet = `${indent}${marker.replace("\\.", ".")} `;
    const body = lines.join(" ").replace(LIST_MARKER, "");
    return wrap(clean(body), bullet, " ".repeat(bullet.length));
  }
  return wrap(clean(lines.join(" ")), "", "");
}

/** The commit a Doc was taken from, as its banner says, or null. */
export function bannerCommit(exported: string): string | null {
  return exported.match(/Taken from commit\W{0,3}([0-9a-f]{7,40})/)?.[1] ?? null;
}

export interface PullReport {
  /** Units of the repository's text replaced or removed because of the Doc. */
  replaced: number;
  /** Units taken from the Doc. */
  added: number;
  /** Replaced text that held a link the Doc could not carry, to re-add by hand. */
  linksToRestore: string[];
  /** Diagrams the Doc no longer shows; kept, since a Doc cannot edit one. */
  diagramsKept: number;
}

/** Longest common subsequence of two key lists, as index pairs. */
function commonPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function snippet(text: string): string {
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/**
 * `source` (the repository's document at the commit the Doc was taken from)
 * with the edits the Doc's export shows, and what was done.
 */
export function applyDocEdits(source: string, exported: string): { markdown: string; report: PullReport } {
  const { units: ours, trailingNewline, trailingBlanks } = segment(source);
  let theirs = segment(exported).units;
  // The banner the push adds is everything up to the line naming the commit.
  const bannerEnd = theirs.findIndex((unit) => /Taken from commit/.test(unit.raw));
  if (bannerEnd >= 0 && bannerEnd < 5) theirs = theirs.slice(bannerEnd + 1);
  theirs = theirs.filter((unit) => key(unit) !== DROP);

  const ourKeys = ours.map(key);
  const theirKeys = theirs.map(key);
  const pairs = commonPairs(ourKeys, theirKeys);
  pairs.push([ours.length, theirs.length]);

  const report: PullReport = { replaced: 0, added: 0, linksToRestore: [], diagramsKept: 0 };
  const out: Unit[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    const removed = ours.slice(i, pi);
    const added = theirs.slice(j, pj);
    const firstBlank = removed[0]?.blankBefore;
    for (const unit of removed) {
      if (key(unit) === DIAGRAM) {
        report.diagramsKept++;
        out.push(unit);
        continue;
      }
      report.replaced++;
      if (/\]\(#/.test(unit.raw)) report.linksToRestore.push(snippet(key(unit)));
    }
    added.forEach((unit, n) => {
      if (key(unit) === DIAGRAM) return;
      report.added++;
      const previous = out[out.length - 1];
      // In place of what it replaced, spaced as that was; otherwise a list
      // item or table row follows its neighbour directly.
      const follows = (unit.kind === "item" || unit.kind === "row") && previous?.kind === unit.kind;
      const blankBefore = n === 0 && firstBlank !== undefined ? firstBlank : follows ? 0 : 1;
      out.push({ kind: unit.kind, raw: toRepositoryStyle(unit), blankBefore });
    });
    if (pi < ours.length) out.push(ours[pi]);
    i = pi + 1;
    j = pj + 1;
  }
  return { markdown: join(out, trailingNewline, trailingBlanks), report };
}
