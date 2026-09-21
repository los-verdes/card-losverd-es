/**
 * CLI: compares an import against the export it came from. See ./README.md.
 *
 * Usage (via `just legacy-import-verify <env> <export.json>`):
 *   node verify-import.mjs <env> <export.json>
 *
 * Runs one counting query through `wrangler d1 execute --remote` and checks
 * the answers against the export. Exits non-zero when they disagree, so this
 * can gate the step that follows rather than being read and nodded at.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseLegacyExport } from "../../src/legacy/import-sql";
import {
  COUNTS_SQL,
  compareCounts,
  expectedCounts,
  formatComparison,
  type ActualCounts,
} from "../../src/legacy/verify-import";

/**
 * Wrangler's own entry point, to be run with the Node already running this.
 *
 * Not `npx`: on Windows that is a `.cmd`, and a version manager may shim it
 * with another one. Node cannot spawn a batch file without a shell, and the
 * shim reported the multi-line SQL below as "batch file arguments are
 * invalid" -- a message naming neither wrangler nor this script, on the step
 * that confirms a one-way import landed.
 *
 * The package blocks `./bin/wrangler.js` in its `exports`, so the path comes
 * from its own manifest rather than being spelled out here and going stale.
 */
function wranglerEntry(): string {
  const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const { bin } = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: { wrangler: string } };
  return resolve(dirname(pkgPath), bin.wrangler);
}

const [envName, exportPath] = process.argv.slice(2);
if (!envName || !exportPath) {
  console.error("usage: verify-import <staging|production> <export.json>");
  process.exit(2);
}

const data = parseLegacyExport(JSON.parse(readFileSync(exportPath, "utf8")));
const expected = expectedCounts(data);

// Production is the unnamed default environment in wrangler.toml, the same
// shape `just db-migrate` uses.
const database =
  envName === "production"
    ? "card-losverd-es-db-production"
    : `card-losverd-es-db-${envName}`;
const envArgs = envName === "production" ? ["--env", ""] : ["--env", envName];

let raw: string;
try {
  raw = execFileSync(
    process.execPath,
    [
      wranglerEntry(),
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      ...envArgs,
      // One line: the query is easier to read across several, but a newline
      // inside a command-line argument is the kind of thing a platform
      // mangles quietly.
      "--command",
      COUNTS_SQL.replace(/\s+/g, " ").trim(),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch {
  // wrangler has already said what went wrong on stderr; repeating it here
  // only buries it.
  console.error(`\nCould not read counts from ${database}.`);
  process.exit(1);
}

// `--json` wraps results in an array of statement results.
const parsed = JSON.parse(raw) as Array<{ results: ActualCounts[] }>;
const actual = parsed[0]?.results?.[0];
if (!actual) {
  console.error(`No counts came back from ${database}. Has the schema been migrated?`);
  process.exit(1);
}

const results = compareCounts(expected, actual);
console.log(`Export taken ${data.exported_at}, checked against ${database}:\n`);
console.log(formatComparison(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
