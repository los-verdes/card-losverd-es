/**
 * Minimal RFC 4180 CSV writer for admin report downloads.
 *
 * Report cells hold text typed by the public at checkout (names, emails), and
 * these files get opened in spreadsheets, where a cell beginning with `=`,
 * `+`, `-`, `@`, tab, or carriage return is evaluated as a formula. Such
 * cells are prefixed with an apostrophe, which spreadsheets treat as "this is
 * text" (OWASP's CSV injection guidance).
 */

export type CsvCell = string | number | null | undefined;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  // Numbers are written as-is: a negative number is data, not a formula.
  if (typeof value === "number") return String(value);
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header row plus one line per row, CRLF-terminated per RFC 4180. */
export function toCsv<Row extends Record<string, CsvCell>>(
  columns: readonly (keyof Row & string)[],
  rows: readonly Row[],
): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
