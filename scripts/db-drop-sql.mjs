// Turns the table list `just db-rebuild` reads from an environment's database
// into the SQL that drops them all, and prints the list so the person running
// it can see exactly what is about to go.
//
// Tables are dropped children first. SQLite enforces foreign keys while it
// drops a table -- dropping deletes the rows first -- and a child table whose
// parent has already gone cannot be dropped at all ("no such table"), deferred
// checks or not. So each table's `REFERENCES` are read from its own schema and
// the drops ordered so nothing is dropped while a table pointing at it
// remains. Foreign keys are also deferred, for the rows themselves.
// `d1_migrations` is in the list on purpose -- it is what makes the
// migrations apply again from the first.
//
// Usage: node scripts/db-drop-sql.mjs <tables.json> <drop.sql>

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: db-drop-sql.mjs <tables.json from wrangler d1 execute --json> <drop.sql>");
  process.exit(2);
}

const [{ results }] = JSON.parse(readFileSync(input, "utf8"));
const parentsOf = new Map(
  results.map(({ name, sql }) => [
    name,
    new Set(
      [...String(sql ?? "").matchAll(/REFERENCES\s+"?(\w+)"?/gi)]
        .map((match) => match[1])
        .filter((parent) => parent !== name),
    ),
  ]),
);

// Children first: a table can go once no remaining table references it.
const tables = [];
const remaining = new Set(parentsOf.keys());
while (remaining.size > 0) {
  const ready = [...remaining].filter(
    (table) => ![...remaining].some((other) => parentsOf.get(other).has(table)),
  );
  if (ready.length === 0) {
    console.error(`Could not order the drops; these reference each other: ${[...remaining].join(", ")}`);
    process.exit(1);
  }
  for (const table of ready.sort()) {
    tables.push(table);
    remaining.delete(table);
  }
}
if (tables.length === 0) {
  console.error("No tables found; the database is already empty or the query went to the wrong place.");
  process.exit(1);
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
writeFileSync(
  output,
  [
    "PRAGMA defer_foreign_keys = on;",
    ...tables.map((name) => `DROP TABLE IF EXISTS ${quote(name)};`),
    "PRAGMA defer_foreign_keys = off;",
    "",
  ].join("\n"),
);

console.log(`${tables.length} tables will be dropped:`);
for (const name of tables) console.log(`  ${name}`);
