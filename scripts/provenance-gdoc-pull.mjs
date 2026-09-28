/**
 * Brings edits made in the provenance document's Google Doc copy back into
 * the repository: the reverse of scripts/provenance-gdoc-push.mjs.
 *
 * The Doc is exported as Markdown, compared unit by unit with the version of
 * docs/membership-card-provenance.md it was taken from (its banner names the
 * commit), and whatever somebody changed in it is merged into the working
 * copy with `git merge-file` (scripts/lib/gdocPull.ts). The result is left
 * as ordinary unstaged changes: review with `git diff`, stage with
 * `git add -p`. Anything changed in the repository since that commit is
 * kept; where both sides changed the same lines, the usual conflict markers
 * say so.
 *
 * Usage (via `just provenance-gdoc-pull`):
 *   node scripts/provenance-gdoc-pull.mjs                  # fetch the Doc
 *   node scripts/provenance-gdoc-pull.mjs --file doc.md    # a downloaded export
 *   node scripts/provenance-gdoc-pull.mjs --summary out.md # also write a PR summary
 *   node scripts/provenance-gdoc-pull.mjs --public         # counts comments, never quotes them
 *
 * Fetching needs a Google access token that can read the Doc: GOOGLE_ACCESS_TOKEN
 * if set, otherwise `gcloud auth print-access-token` after a one-time
 * `gcloud auth login --enable-gdrive-access`. The Doc is PROVENANCE_GDOC_ID,
 * `--doc-id`, or the repository variable of that name. A fetch also records
 * how far the Doc has been pulled (PULL_STATE, below), so the refresh stops
 * refusing to replace it over edits that are now in the repository, and
 * lists its open comments, which an export does not carry.
 *
 * A downloaded export (File > Download > Markdown) needs none of that, but
 * records nothing: the refresh stays held until the Doc's own edits are
 * carried back some other way.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDocEdits, bannerCommit } from "./lib/gdocPull.ts";
import { PULL_STATE } from "./lib/provenanceGdocGuard.ts";

const SOURCE = "docs/membership-card-provenance.md";
const API_ROOT = process.env.GOOGLE_API_ROOT ?? "https://www.googleapis.com";
const DRIVE = `${API_ROOT}/drive/v3`;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = option("--file");
const summaryPath = option("--summary");
// Where the output is read by more than whoever ran it -- a workflow's log
// on a public repository -- comments are counted, never quoted.
const publicRun = args.includes("--public");

function die(message) {
  console.error(`::error title=Provenance Google Doc not pulled::${message.replaceAll("\n", "%0A")}`);
  process.exit(1);
}

function run(command, commandArgs) {
  return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function docId() {
  const given = option("--doc-id") ?? process.env.PROVENANCE_GDOC_ID;
  if (given) return given;
  try {
    return run("gh", ["variable", "get", "PROVENANCE_GDOC_ID"]);
  } catch {
    die("No Doc to pull from: set PROVENANCE_GDOC_ID or pass --doc-id.");
  }
}

function accessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  try {
    return run("gcloud", ["auth", "print-access-token"]);
  } catch {
    die(
      "No Google access token. Sign in once with `gcloud auth login --enable-gdrive-access`, " +
        "or pass a downloaded export with --file.",
    );
  }
}

// 1. The Doc, as Markdown.
let exported;
let fetched = null;
if (file) {
  exported = readFileSync(file, "utf8");
} else {
  const id = docId();
  const token = accessToken();
  const get = async (path) => {
    const res = await fetch(`${DRIVE}/files/${id}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) die(`GET ${path.split("?")[0] || "/"} answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res;
  };
  const listAll = async (path, field, fields) => {
    const items = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ fields: `nextPageToken,${field}(${fields})`, pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await (await get(`/${path}?${params}`)).json();
      items.push(...(page[field] ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  };
  exported = await (await get("/export?mimeType=text%2Fmarkdown")).text();
  const revisions = await listAll("revisions", "revisions", "id,modifiedTime");
  const comments = await listAll("comments", "comments", "deleted,resolved,content,quotedFileContent(value),author(displayName)");
  fetched = {
    lastRevision: revisions.map((revision) => revision.modifiedTime).filter(Boolean).sort().at(-1) ?? null,
    comments: comments.filter((comment) => !comment.deleted && !comment.resolved),
  };
}

// 2. What it was taken from, and what it says now.
const commit = bannerCommit(exported);
if (!commit) die("The export has no \"Taken from commit\" banner, so there is nothing to compare it against.");
let base;
try {
  base = run("git", ["show", `${commit}:${SOURCE}`]) + "\n";
} catch {
  die(`Commit ${commit}, which the Doc was taken from, is not in this clone. Fetch it (git fetch origin) and re-run.`);
}
const { markdown: theirs, report } = applyDocEdits(base, exported);

// 3. Merged into the working copy. Only the Doc's edits move; what the
// repository has changed since that commit stays.
let conflicts = 0;
if (theirs !== base) {
  const work = mkdtempSync(join(tmpdir(), "provenance-gdoc-pull-"));
  writeFileSync(join(work, "base.md"), base);
  writeFileSync(join(work, "doc.md"), theirs);
  const merge = spawnSync("git", [
    "merge-file",
    "-L", "repository", "-L", `commit ${commit}, as the Doc was taken`, "-L", "Google Doc",
    SOURCE, join(work, "base.md"), join(work, "doc.md"),
  ]);
  if (merge.status < 0 || merge.status === null) die(`git merge-file failed: ${merge.stderr}`);
  conflicts = merge.status;
}

// 4. How far the Doc has been pulled, so the refresh will replace it again
// once these edits are merged (scripts/lib/provenanceGdocGuard.ts).
if (fetched?.lastRevision) {
  writeFileSync(PULL_STATE, `${JSON.stringify({ pulledThrough: fetched.lastRevision }, null, 2)}\n`);
}

// 5. What happened.
const lines = [];
if (theirs === base) {
  lines.push(`The Doc says nothing the repository did not already say at ${commit}.`);
} else {
  lines.push(
    `From the Doc (taken from ${commit}): ${report.added} passage(s) taken in, replacing or removing ${report.replaced}.`,
  );
  if (conflicts > 0) {
    lines.push(`${conflicts} conflict(s) with changes made in the repository since: see the markers in ${SOURCE}.`);
  }
}
if (report.linksToRestore.length > 0) {
  lines.push("Edited passages that held a link to another section, which the Doc could not carry; re-add it:");
  for (const text of report.linksToRestore) lines.push(`  - "${text}"`);
}
if (report.diagramsKept > 0) {
  lines.push(`${report.diagramsKept} diagram(s) missing from the Doc were kept; a diagram is changed in the repository.`);
}
if (fetched) {
  lines.push(`Recorded the Doc as pulled through ${fetched.lastRevision} (${PULL_STATE}).`);
}
console.log(lines.join("\n"));

// Open comments are printed only for whoever ran this, never into the
// summary: that goes into a public pull request, and a comment is somebody's
// words, under their name.
if (fetched?.comments.length && publicRun) {
  console.log(`\n${fetched.comments.length} open comment(s) in the Doc to carry back by hand; read them in the Doc.`);
} else if (fetched?.comments.length) {
  console.log(`\n${fetched.comments.length} open comment(s) in the Doc, not carried by an export:`);
  for (const comment of fetched.comments) {
    const quoted = comment.quotedFileContent?.value?.replace(/\s+/g, " ").slice(0, 80);
    console.log(`- ${comment.author?.displayName ?? "someone"}${quoted ? ` on "${quoted}"` : ""}: ${comment.content}`);
  }
  console.log("Carry what they ask for back here, then resolve or delete them in the Doc; the refresh waits until then.");
}
if (theirs !== base) console.log(`\nReview with \`git diff ${SOURCE}\`, then stage with \`git add -p\`.`);

if (summaryPath) {
  const summary = [...lines];
  if (fetched?.comments.length) summary.push(`${fetched.comments.length} open comment(s) in the Doc to carry back by hand.`);
  writeFileSync(summaryPath, `${summary.join("\n")}\n`);
}
