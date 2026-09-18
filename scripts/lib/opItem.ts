/**
 * Reading a 1Password item the way every tool in `scripts/` does.
 *
 * All of them are invoked the same way from the justfile -- `op item get ...
 * --format json | node scripts/<tool>` -- because piping keeps secrets off
 * disk and out of command-line arguments, where another process could read
 * them. That shared shape had produced a shared pair of functions, copied
 * into four tools with the usual small divergences: one returns null for a
 * missing field where the others abort, and the error wording drifted.
 *
 * Each tool keeps its own `fail`, since the message it prints is prefixed
 * with its own name, so that is passed in rather than reinvented here.
 *
 * Import-free, so the `.mjs` tools can import it directly under Node's
 * TypeScript type stripping (`./lib/opItem.ts`) while the one bundled with
 * esbuild imports it normally.
 */

export interface OpField {
  label: string;
  value?: string;
}

export interface OpItem {
  title?: string;
  fields?: OpField[];
}

/** Aborts the tool, having said why. Never returns. */
export type Fail = (message: string) => never;

/**
 * The piped `op item get --format json` payload.
 *
 * A failure here is almost always `op` itself having failed -- not signed in,
 * no such item, wrong vault -- and it reaches us as an empty stdin or a shell
 * error rather than as JSON, so the message says where to look.
 */
export async function readOpItemFromStdin(fail: Fail): Promise<OpItem> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as OpItem;
  } catch {
    return fail(
      "expected the 1Password item as JSON on stdin (did `op item get` fail?)",
    );
  }
}

/** A field's value, or null when the item hasn't got one yet. */
export function opFieldOrNull(item: OpItem, label: string): string | null {
  return item.fields?.find((field) => field.label === label)?.value ?? null;
}

/**
 * A field's value, aborting when it is absent. An empty value counts as
 * absent: 1Password keeps the field once it has been created, so a blank one
 * means "not filled in yet" rather than "deliberately empty", and every
 * caller here wants a credential.
 */
export function opField(item: OpItem, label: string, fail: Fail): string {
  return (
    opFieldOrNull(item, label) ??
    fail(`1Password item "${item.title}" has no ${label}`)
  );
}
