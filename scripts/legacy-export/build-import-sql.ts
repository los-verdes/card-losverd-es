/**
 * CLI wrapper around src/legacy/import-sql.ts: reads the JSON produced by
 * ./export.sql and writes D1-ready SQL. See ./README.md.
 *
 * Usage (via `just legacy-import-sql <export.json> <out.sql>`):
 *   node build-import-sql.mjs <export.json> <out.sql>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildImportSql, parseLegacyExport } from "../../src/legacy/import-sql";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: build-import-sql <export.json> <out.sql>");
  process.exit(2);
}

const data = parseLegacyExport(JSON.parse(readFileSync(inputPath, "utf8")));
writeFileSync(outputPath, buildImportSql(data));
console.log(
  `Wrote ${outputPath}: ${data.member_since.length} member_since rows, ` +
    `${data.membership_cards.length} membership cards (export taken ${data.exported_at}).`,
);
