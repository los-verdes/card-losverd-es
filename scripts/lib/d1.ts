/**
 * Running one SQL statement against an environment's remote D1 database, for
 * operator scripts that need an answer back rather than a table printed.
 *
 * Wrangler is run through its own entry point with the Node already running,
 * not through `npx`. On Windows `npx` is a `.cmd`, which Node cannot spawn
 * without a shell, and a version manager may shim it with another one -- the
 * failure that surfaced as "mise ERROR batch file arguments are invalid" on
 * the step confirming the legacy import had landed.
 *
 * Import-free apart from Node built-ins, so `.mjs` tools can import it
 * directly under Node's type stripping -- the same arrangement as `opItem.ts`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export const ENVIRONMENTS = ["production", "staging"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Wrangler's own entry point, found through its manifest. */
function wranglerEntry(): string {
  const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const { bin } = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: { wrangler: string } };
  return resolve(dirname(pkgPath), bin.wrangler);
}

/**
 * Wrangler's own account of a failure, as one or two lines.
 *
 * With `--json` it prints the error as JSON on stdout rather than prose on
 * stderr, so an uncaught failure surfaced as a Node stack trace with the
 * reason buried twenty lines down. The reason is the only part worth showing.
 */
function wranglerFailure(error: unknown): string {
  const stdout = (error as { stdout?: string }).stdout ?? "";
  try {
    const parsed = JSON.parse(stdout) as {
      error?: { text?: string; notes?: Array<{ text?: string }> };
    };
    const lines = [parsed.error?.text, ...(parsed.error?.notes ?? []).map((note) => note.text)];
    const reason = lines.filter(Boolean).join("\n  ");
    if (reason) {
      // Worth naming, because it is the first thing to go wrong after an
      // account move: wrangler falls back to whichever account it is logged
      // into, which need not be the one this project now lives in.
      return /code: 7403/.test(reason)
        ? `${reason}\n  Check which Cloudflare account this ran against -- CLOUDFLARE_ACCOUNT_ID, or whichever account wrangler is logged into.`
        : reason;
    }
  } catch {
    // Not JSON: fall through to whatever the process said.
  }
  return String((error as Error).message ?? error).split("\n")[0];
}

/**
 * The rows one statement returns, plus how many it changed. Throws an Error
 * carrying wrangler's reason, not a stack trace.
 */
export function runD1<Row = Record<string, unknown>>(
  env: Environment,
  sql: string,
): { rows: Row[]; changes: number } {
  const envArgs = env === "production" ? ["--env", ""] : ["--env", env];
  let raw: string;
  try {
    raw = execFileSync(
    process.execPath,
    [
      wranglerEntry(),
      "d1",
      "execute",
      `card-losverd-es-db-${env}`,
      "--remote",
      "--json",
      ...envArgs,
      // One line: a newline inside a command-line argument is the kind of
      // thing a platform mangles quietly.
      "--command",
      sql.replace(/\s+/g, " ").trim(),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  } catch (error) {
    throw new Error(wranglerFailure(error));
  }
  const parsed = JSON.parse(raw) as Array<{ results: Row[]; meta?: { changes?: number } }>;
  return { rows: parsed[0]?.results ?? [], changes: parsed[0]?.meta?.changes ?? 0 };
}

/**
 * A value safe to place inside a single-quoted SQL literal, or null.
 *
 * `wrangler d1 execute --command` has no bound parameters, so the value is
 * interpolated. Rather than escape, this refuses anything that could close
 * the literal or start another statement: an address with a quote, a
 * backslash, a semicolon or whitespace in it is not one worth handling here.
 */
export function sqlSafeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s'"\\;@]+@[^\s'"\\;@]+\.[^\s'"\\;@]+$/.test(email) ? email : null;
}
