// Does an environment's database match what the migrations produce?
//
// Normally nothing has to ask: a database that has applied every migration is
// by definition what they produce. A squash breaks that. It rewrites what
// "already applied" means, so a database carrying the old history keeps the
// schema the old files built, and nothing in the tooling will mention that it
// is no longer the schema anyone can reproduce.
//
// So this asks directly, by building a throwaway local database from the
// migrations and comparing it object by object with a real one.
//
//   node scripts/schema-compare.mjs <expected.json> <actual.json>
//
// Both arguments are `wrangler d1 execute --json` output for the query in
// SCHEMA_SQL below. `just db-schema-compare <env>` produces them.
//
// Names, types and constraints are compared; comments and whitespace are not.
// Column *order* is, and deliberately: two tables with the same columns in a
// different order are the same table to every query this project makes, but
// the difference is the fingerprint of a schema built by a path nobody can
// walk again, which is exactly what this exists to find.

import { readFileSync } from "node:fs";

/**
 * The query both sides must have been produced by. `substr` rather than a
 * LIKE with ESCAPE, because the backslashes that needs do not survive the trip
 * through just and bash intact, and the Cloudflare tables are the only ones
 * that begin `_cf_`.
 */
export const SCHEMA_SQL =
  "SELECT type, name, sql FROM sqlite_master " +
  "WHERE name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' " +
  "AND name != 'd1_migrations' ORDER BY type, name";

function fail(message) {
  console.error(`schema-compare: ${message}`);
  process.exit(1);
}

function load(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`cannot read ${path} as JSON (did the wrangler command fail?)`);
  }
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  if (!Array.isArray(results)) fail(`${path} is not \`wrangler d1 execute --json\` output`);
  return new Map(results.map((row) => [row.name, row]));
}

/** Structure only: comments, whitespace and SQLite's own quoting are noise. */
function normalise(sql) {
  return (sql ?? "")
    .replace(/--[^\n]*/g, " ")
    .replace(/"([A-Za-z0-9_]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase();
}

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  fail("usage: schema-compare <expected.json> <actual.json>");
}

const expected = load(expectedPath);
const actual = load(actualPath);

const missing = [...expected.keys()].filter((name) => !actual.has(name));
const extra = [...actual.keys()].filter((name) => !expected.has(name));
const changed = [...expected.keys()]
  .filter((name) => actual.has(name))
  .filter((name) => normalise(expected.get(name).sql) !== normalise(actual.get(name).sql));

for (const name of missing) console.log(`  missing   ${name} -- the migrations create it; this database has not`);
for (const name of extra) console.log(`  extra     ${name} -- this database has it; the migrations do not create it`);
for (const name of changed) {
  console.log(`  differs   ${name}`);
  console.log(`      migrations: ${normalise(expected.get(name).sql)}`);
  console.log(`      database:   ${normalise(actual.get(name).sql)}`);
}

const problems = missing.length + extra.length + changed.length;
if (problems === 0) {
  console.log(`All ${expected.size} objects match what the migrations produce.`);
  process.exit(0);
}
console.log(
  `\n${problems} of ${expected.size} objects differ. This database was not built by the ` +
    `migrations as they stand, so it cannot be recreated from them.\n` +
    `After a squash that is expected until the database is rebuilt; see "Squash the ` +
    `migrations" in docs/cutover.md.`,
);
process.exit(1);
