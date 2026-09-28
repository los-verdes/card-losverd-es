/**
 * Prepares the provenance document for Google Docs.
 *
 * The Merch Team and the Membership Committee would rather comment in Google
 * Docs than in a repository, and that is a reasonable preference: the people
 * this document is written for are volunteers, not engineers. Google Docs
 * imports Markdown directly (Drive -> Open with -> Google Docs), so this does
 * not convert anything. What it does is fix the three things that make a
 * repository document read badly once it is out of the repository.
 *
 * Usage (via `just provenance-gdoc`):
 *   node provenance-gdoc.mjs [out.md] [--diagram-links]
 *
 * The repository's copy stays the source of truth. Re-run this and re-import
 * whenever the document changes; the banner carries the commit it was taken
 * from, so a reader can tell which version they are looking at and two copies
 * can be told apart at a glance.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { KROKI_ROOT, mermaidPngUrl, replaceDiagrams } from "./lib/diagramImages.ts";

const SOURCE = "docs/membership-card-provenance.md";
const BLOB = "https://github.com/los-verdes/card-losverd-es/blob/main";
const args = process.argv.slice(2);
const outPath = args.find((arg) => !arg.startsWith("--")) ?? ".provenance-gdoc.md";
const diagramLinks = args.includes("--diagram-links");
// Overridable only so the push can be tried against a stand-in.
const kroki = process.env.KROKI_ROOT ?? KROKI_ROOT;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const commit = git("rev-parse", "--short", "HEAD");
const commitDate = git("log", "-1", "--format=%cs");
// Normalised first: git may check this file out with CRLF endings, and a
// pattern written for LF then matches nothing at all -- silently, which is
// how the diagrams were missed the first time this ran.
let md = readFileSync(SOURCE, "utf8").split("\r\n").join("\n");

/*
 * 1. Diagrams. Google Docs cannot render Mermaid, and pasting its source into
 *    a document for volunteers is worse than leaving it out -- it looks like
 *    something has gone wrong. Each becomes an image instead, rendered from
 *    its own source (scripts/lib/diagramImages.ts), with the repository's
 *    copy a link away. `--diagram-links` leaves just that link, as this did
 *    before the images: the push falls back to it if the images cannot be
 *    had, since a Doc with holes where the pictures were is worse than one
 *    that says where to find them.
 */
const repositoryCopy = `[the repository's copy](${BLOB}/${SOURCE})`;
const { markdown: withDiagrams, diagrams } = replaceDiagrams(md, ({ number, source }) =>
  diagramLinks
    ? `> **Diagram ${number}** — this renders on ${repositoryCopy}.`
    : `![Diagram ${number}](${mermaidPngUrl(source, kroki)})\n\n_Diagram ${number}, as on ${repositoryCopy}._`,
);
md = withDiagrams;

/*
 * 2. Internal cross-references. `#9-decisions-worth-confirming` means nothing
 *    once this is a Google Doc; the link would simply be dead. The sections
 *    are numbered, and a Google Doc has an outline down the side, so the
 *    text alone -- "section 5" -- navigates fine. Dropping the link is
 *    better than pointing it somewhere that leaves the document.
 */
let anchors = 0;
md = md.replace(/\[([^\]]+)\]\(#[^)]+\)/g, (_, text) => {
  anchors++;
  return text;
});

/*
 * 3. Repository-relative paths, which would 404 from a Google Doc. These are
 *    the few links that genuinely point at something worth following, so
 *    they are made absolute rather than dropped.
 */
md = md.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path) => `](${BLOB}/${path})`);

const banner = `> **This is a copy, for reading and commenting.** The version that the
> software is built against lives in the repository, and that one is the
> source of truth: [${SOURCE}](${BLOB}/${SOURCE}).
>
> Taken from commit \`${commit}\` (${commitDate}). Comments here are welcome and
> wanted — they are the reason this copy exists. Edits made here do not reach
> the software, and will be lost the next time this is refreshed, so anything
> that should stick needs to go back to the repository.

`;

writeFileSync(outPath, banner + md);
console.log(
  `Wrote ${outPath} from ${SOURCE} at ${commit} (${commitDate}).\n` +
    `  ${diagrams.length} diagram(s) ${diagramLinks ? "replaced with a link" : "rendered as images"}, ${anchors} internal link(s) flattened.\n\n` +
    `To share it: upload to Google Drive, then right-click the file and choose\n` +
    `"Open with" -> "Google Docs". Drive converts the Markdown into a real\n` +
    `document with headings, tables and an outline.\n\n` +
    `Re-run this and re-import whenever the repository's copy changes.`,
);
