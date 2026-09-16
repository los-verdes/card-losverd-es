/**
 * Turns the legacy Postgres export (scripts/legacy-export/export.sql) into
 * idempotent D1 statements. Pure and runtime-agnostic: the CLI wrapper in
 * scripts/legacy-export/ handles file I/O, and tests execute the output
 * against the real migrated schema.
 *
 * Validation is deliberately strict -- a malformed row aborts the whole
 * import rather than being skipped, since this data is unrecoverable once
 * Postgres is decommissioned (plan Phase 8.3) and a silently-dropped row
 * would go unnoticed.
 */

export interface LegacyMemberSince {
  email: string;
  member_since: string;
}

export interface LegacyMembershipCard {
  serial_number: string;
  email: string;
  full_name: string | null;
  member_since: string | null;
  member_until: string | null;
}

export interface LegacyExport {
  format_version: 1;
  exported_at: string;
  member_since: LegacyMemberSince[];
  membership_cards: LegacyMembershipCard[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(path: string, message: string): never {
  throw new Error(`Invalid legacy export at ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    fail(`${path}.${key}`, "expected a non-empty string");
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    fail(`${path}.${key}`, "expected a string or null");
  return value;
}

function requireEmail(obj: Record<string, unknown>, path: string): string {
  const email = requireString(obj, "email", path);
  if (email !== email.toLowerCase() || !email.includes("@")) {
    fail(`${path}.email`, "expected a lower-cased email address");
  }
  return email;
}

function checkDate(value: string | null, path: string): void {
  if (value !== null && !ISO_DATE.test(value))
    fail(path, "expected YYYY-MM-DD");
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(key, "expected an array");
  return value;
}

export function parseLegacyExport(input: unknown): LegacyExport {
  if (!isRecord(input)) fail("$", "expected a JSON object");
  if (input.format_version !== 1) fail("format_version", "expected 1");
  const exportedAt = requireString(input, "exported_at", "$");
  // Interpolated into a SQL comment by buildImportSql(), so must not be free text.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(exportedAt)) {
    fail("exported_at", "expected YYYY-MM-DDTHH:MM:SSZ");
  }

  const seenEmails = new Set<string>();
  const memberSince = requireArray(input, "member_since").map((row, i) => {
    const path = `member_since[${i}]`;
    if (!isRecord(row)) fail(path, "expected an object");
    const email = requireEmail(row, path);
    if (seenEmails.has(email))
      fail(`${path}.email`, `duplicate email ${email}`);
    seenEmails.add(email);
    const date = requireString(row, "member_since", path);
    checkDate(date, `${path}.member_since`);
    return { email, member_since: date };
  });

  const seenSerials = new Set<string>();
  const cards = requireArray(input, "membership_cards").map((row, i) => {
    const path = `membership_cards[${i}]`;
    if (!isRecord(row)) fail(path, "expected an object");
    const serial = requireString(row, "serial_number", path);
    if (!UUID.test(serial))
      fail(`${path}.serial_number`, "expected a lower-case UUID");
    if (seenSerials.has(serial))
      fail(`${path}.serial_number`, `duplicate serial ${serial}`);
    seenSerials.add(serial);
    const card: LegacyMembershipCard = {
      serial_number: serial,
      email: requireEmail(row, path),
      full_name: optionalString(row, "full_name", path),
      member_since: optionalString(row, "member_since", path),
      member_until: optionalString(row, "member_until", path),
    };
    checkDate(card.member_since, `${path}.member_since`);
    checkDate(card.member_until, `${path}.member_until`);
    return card;
  });

  return {
    format_version: 1,
    exported_at: exportedAt,
    member_since: memberSince,
    membership_cards: cards,
  };
}

/** SQLite string literal. Standard SQL quoting: only `'` needs escaping. */
function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

/**
 * Idempotent statements (safe to re-run any number of times):
 * 1. Upsert each legacy `member_since` into `member_since_overrides` as
 *    `source = 'legacy_postgres'` -- never overwriting a `manual` override,
 *    which always takes precedence over imported data.
 * 2. Upsert every legacy card into `legacy_membership_cards`.
 *
 * `members` itself is never touched: overrides win at read time, and the
 * table's triggers bump `last_updated_at` for affected members.
 *
 * No BEGIN/COMMIT: D1 rejects explicit transactions in executed SQL.
 */
export function buildImportStatements(data: LegacyExport): string[] {
  const statements: string[] = [];

  for (const row of data.member_since) {
    statements.push(
      `INSERT INTO member_since_overrides (email, member_since, source) VALUES (${literal(row.email)}, ${literal(row.member_since)}, 'legacy_postgres') ` +
        `ON CONFLICT(email) DO UPDATE SET member_since = excluded.member_since, updated_at = unixepoch('subsec') * 1000 ` +
        `WHERE member_since_overrides.source = 'legacy_postgres'`,
    );
  }

  for (const card of data.membership_cards) {
    statements.push(
      `INSERT INTO legacy_membership_cards (serial_number, email, full_name, member_since, member_until) ` +
        `VALUES (${literal(card.serial_number)}, ${literal(card.email)}, ${literal(card.full_name)}, ${literal(card.member_since)}, ${literal(card.member_until)}) ` +
        `ON CONFLICT(serial_number) DO UPDATE SET email = excluded.email, full_name = excluded.full_name, ` +
        `member_since = excluded.member_since, member_until = excluded.member_until`,
    );
  }

  return statements;
}

export function buildImportSql(data: LegacyExport): string {
  return (
    `-- Generated from a legacy Postgres export taken at ${data.exported_at}.\n` +
    `-- ${data.member_since.length} member_since rows, ${data.membership_cards.length} membership cards.\n` +
    buildImportStatements(data)
      .map((s) => `${s};`)
      .join("\n") +
    "\n"
  );
}
