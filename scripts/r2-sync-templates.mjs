// Syncs the committed template images (assets/templates/**.png) into an
// environment's R2 bucket, uploading only the ones whose contents changed
// (scripts/lib/r2Sync.ts). The Deploy workflow runs it, through
// `just r2-upload-templates <env>`, before the Worker that reads them deploys.
//
// Objects in the bucket that are no longer in the repository are left alone,
// as they always have been.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/r2-sync-templates.mjs <bucket> [--dry-run]
//
// `--dry-run` only lists the bucket and says what would be uploaded, so a
// read-only token is enough for it.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { syncFiles } from "./lib/r2Sync.ts";

const [bucket, flag] = process.argv.slice(2);
const dryRun = flag === "--dry-run";
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!bucket || !token || !accountId) {
  console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/r2-sync-templates.mjs <bucket> [--dry-run]");
  process.exit(2);
}

const root = new URL("../assets/", import.meta.url).pathname;
const files = readdirSync(join(root, "templates"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
  .map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const body = readFileSync(path);
    return {
      key: relative(root, path).split("\\").join("/"),
      md5: createHash("md5").update(body).digest("hex"),
      contentType: "image/png",
      body,
    };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const api = { base: process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4", token, accountId, bucket };
const started = Date.now();
const { uploaded, unchanged } = await syncFiles(api, "templates/", files, { dryRun });
const verb = dryRun ? "would upload" : "uploaded";
for (const key of uploaded) console.log(`${verb} ${key}`);
console.log(`${bucket}: ${uploaded.length} ${verb}, ${unchanged} unchanged, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
