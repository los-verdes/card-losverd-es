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
// The same four counts the generated SQL carries in its own header, in the
// same order. Chosen names were missing here, which made them the one thing
// an operator could not see without opening the file -- and they are the
// count most worth looking at, because the export only emits a name that
// differs from the order it came with, so a legitimate answer is zero and a
// broken one looks identical.
console.log(
  `Wrote ${outputPath}: ${data.member_since.length} member_since rows, ` +
    `${data.display_names.length} chosen names, ` +
    `${data.membership_cards.length} membership cards, ` +
    `${data.membership_orders.length} of ${data.membership_orders_total} membership orders ` +
    `(export taken ${data.exported_at}).`,
);
const skipped = data.membership_orders_total - data.membership_orders.length;
if (skipped > 0) {
  console.warn(
    `WARNING: ${skipped} of ${data.membership_orders_total} annual_membership rows were NOT exported ` +
      `(no order id, created_on, or customer email). Inspect them in Postgres before it is decommissioned.`,
  );
}
