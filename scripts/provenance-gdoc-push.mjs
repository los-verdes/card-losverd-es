/**
 * Refreshes the shared Google Doc copy of the provenance document in place,
 * so its link, sharing and version history survive.
 *
 * Run by .github/workflows/provenance-gdoc.yml when the document changes on
 * `main`. It first makes the copy exactly as `just provenance-gdoc` does, then
 * replaces the Doc's content with it -- but only if the Doc holds nothing but
 * what this repository put there (scripts/lib/provenanceGdocGuard.ts). A
 * comment, or an edit by anyone but the owner or this job, stops it: that is
 * somebody's input, and replacing the Doc would detach or discard it.
 *
 * Usage:
 *   GOOGLE_ACCESS_TOKEN=... PROVENANCE_GDOC_ID=... GDOC_REFRESHER=... \
 *     node scripts/provenance-gdoc-push.mjs [--dry-run]
 *
 * GOOGLE_ACCESS_TOKEN has the Drive scope, for an account the Doc is shared
 * with as an editor; GDOC_REFRESHER is that account's address. --dry-run
 * checks whether the Doc could be replaced and changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagramImageUrls } from "./lib/diagramImages.ts";
import { fitImageRequests } from "./lib/fitDocImages.ts";
import { PULL_STATE, reasonsNotToReplace } from "./lib/provenanceGdocGuard.ts";

// Overridable only so the script can be run against a stand-in for Drive.
const API_ROOT = process.env.GOOGLE_API_ROOT ?? "https://www.googleapis.com";
const DRIVE = `${API_ROOT}/drive/v3`;
const UPLOAD = `${API_ROOT}/upload/drive/v3`;
const DOCS = `${process.env.GOOGLE_DOCS_API_ROOT ?? "https://docs.googleapis.com"}/v1/documents`;

const token = process.env.GOOGLE_ACCESS_TOKEN;
const docId = process.env.PROVENANCE_GDOC_ID;
const refresher = process.env.GDOC_REFRESHER;
const dryRun = process.argv.includes("--dry-run");

if (!token || !docId || !refresher) {
  console.error("GOOGLE_ACCESS_TOKEN, PROVENANCE_GDOC_ID and GDOC_REFRESHER are all required.");
  process.exit(2);
}

/** A GitHub Actions warning annotation: the refresh went ahead, with less than hoped. */
function warn(message) {
  console.log(`::warning title=Provenance Google Doc::${message.replaceAll("\n", "%0A")}`);
}

/** A GitHub Actions error annotation, which also reads fine in a terminal. */
function fail(message) {
  console.error(`::error title=Provenance Google Doc not refreshed::${message.replaceAll("\n", "%0A")}`);
  process.exit(1);
}

async function drive(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!res.ok) {
    fail(`${init.method ?? "GET"} ${url.split("?")[0]} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res;
}

async function listAll(path, field, fields) {
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ fields: `nextPageToken,${field}(${fields})`, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await (await drive(`${DRIVE}/files/${docId}/${path}?${params}`)).json();
    items.push(...(page[field] ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

// 1. Is it safe to replace?
const file = await (await drive(`${DRIVE}/files/${docId}?fields=name,mimeType,owners(emailAddress)`)).json();
if (file.mimeType !== "application/vnd.google-apps.document") {
  fail(`${docId} is a ${file.mimeType}, not a Google Doc.`);
}
const state = {
  owners: (file.owners ?? []).map((owner) => owner.emailAddress).filter(Boolean),
  comments: await listAll("comments", "comments", "deleted,resolved,author(displayName)"),
  revisions: await listAll("revisions", "revisions", "id,modifiedTime,lastModifyingUser(emailAddress,displayName)"),
  // How far the Doc's edits have been carried back (scripts/provenance-gdoc-pull.mjs).
  pulledThrough: existsSync(PULL_STATE) ? JSON.parse(readFileSync(PULL_STATE, "utf8")).pulledThrough : null,
};
const reasons = reasonsNotToReplace(state, refresher);
if (reasons.length > 0) {
  fail(
    `"${file.name}" was left as it is, because replacing it would lose somebody's input:\n` +
      reasons.map((reason) => `- ${reason}`).join("\n") +
      "\nOnce that input is back in the repository and the Doc holds none of it, re-run this workflow.",
  );
}
console.log(`"${file.name}": no comments, and no revisions but ${state.owners.join(", ")} and ${refresher}.`);
if (dryRun) {
  console.log("Dry run: safe to replace; nothing changed.");
  process.exit(0);
}

// 2. The copy, made exactly as `just provenance-gdoc` makes it: diagrams as
// images, or (`links`) as a pointer to the repository's copy.
function prepare(links) {
  const out = join(mkdtempSync(join(tmpdir(), "provenance-gdoc-")), "provenance.md");
  execFileSync("node", ["scripts/provenance-gdoc.mjs", out, ...(links ? ["--diagram-links"] : [])], { stdio: "inherit" });
  return readFileSync(out, "utf8");
}

/** Whether every diagram image renders, asked before the Doc is touched. */
async function unrenderable(urls) {
  const failures = [];
  for (const url of urls) {
    const res = await fetch(url).catch((error) => ({ ok: false, status: String(error), headers: new Headers() }));
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/png")) failures.push(`${res.status} ${type}`.trim());
  }
  return failures;
}

async function replaceContent(markdown) {
  await drive(`${UPLOAD}/files/${docId}?uploadType=media&fields=id`, {
    method: "PATCH",
    headers: { "Content-Type": "text/markdown; charset=UTF-8" },
    body: markdown,
  });
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
let markdown = prepare(false);
const images = diagramImageUrls(markdown);
const failures = await unrenderable(images);
if (failures.length > 0) {
  warn(`${failures.length} of ${images.length} diagram(s) did not render (${failures.join("; ")}), so the Doc links to them instead.`);
  markdown = prepare(true);
}
const imageUrls = diagramImageUrls(markdown);
const withImages = imageUrls.length;

// 3. Replace the content. The Doc stays the same file: same link, same
// sharing, and the previous content kept in its version history.
await replaceContent(markdown);

// 4. Check it arrived as a document, not as Markdown source shown as text.
const text = await (await drive(`${DRIVE}/files/${docId}/export?mimeType=text/plain`)).text();
if (!text.includes(`Taken from commit ${commit}`) || text.includes("**This is a copy")) {
  fail(
    `"${file.name}" was replaced, but does not read as a converted document (commit ${commit}). ` +
      "Restore the previous version from File > Version history in the Doc.",
  );
}

// 5. And that the diagrams arrived as pictures. Drive fetches an image named
// by URL while converting; if it did not, the Doc has a gap where each one
// was, so it is replaced once more with the version that links instead.
let imagesInDoc = false;
if (withImages > 0) {
  const html = await (await drive(`${DRIVE}/files/${docId}/export?mimeType=text/html`)).text();
  const imported = (html.match(/<img\b/g) ?? []).length;
  if (imported < withImages) {
    warn(`Only ${imported} of ${withImages} diagram image(s) arrived in the Doc, so it links to them instead.`);
    await replaceContent(prepare(true));
  } else {
    imagesInDoc = true;
  }
}

// 6. Fit the diagrams to the page. Drive imports each at its natural width,
// which can run past the right margin (scripts/lib/fitDocImages.ts). Only a
// nicety: if the Docs API cannot do it, the Doc is still right, just wide.
async function docsApi(path, init = {}) {
  const res = await fetch(`${DOCS}/${docId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  return { res, body: await res.text() };
}
if (imagesInDoc) {
  const got = await docsApi("?fields=documentStyle,body.content.paragraph.elements(startIndex,inlineObjectElement),inlineObjects");
  const plan = got.res.ok ? fitImageRequests(JSON.parse(got.body), imageUrls) : null;
  if (!plan) {
    warn(`The diagrams were left at their natural width: the Docs API answered ${got.res.status}: ${got.body.slice(0, 300)}`);
  } else if ("mismatch" in plan) {
    warn(`The diagrams were left at their natural width: ${plan.mismatch}.`);
  } else if (plan.resized > 0) {
    const update = await docsApi(":batchUpdate", { method: "POST", body: JSON.stringify({ requests: plan.requests }) });
    if (update.res.ok) console.log(`Fitted ${plan.resized} diagram(s) to the page.`);
    else warn(`The diagrams were left at their natural width: the Docs API answered ${update.res.status}: ${update.body.slice(0, 300)}`);
  }
}
console.log(`Refreshed "${file.name}" from commit ${commit}.`);
