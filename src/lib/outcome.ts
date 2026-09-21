/**
 * What happened to a visitor at the points where this Worker makes a
 * decision about them, written to Workers Logs as one structured line each.
 *
 * The page beacon (src/member/webAnalytics.tsx) sees that somebody loaded
 * `/`; it cannot see whether they got a card, landed on "no membership", or
 * were an Apple Hide My Email address with orders under another one. Those
 * are the cases the first real visits after cutover are expected to turn up,
 * so each decision point says which way it went, and the Workers Logs query
 * builder can count them by field.
 *
 * Categories only. Nothing here identifies a person: no address, name, order
 * number, serial or device -- Workers Logs keeps lines for seven days and is
 * read by more people than the database is. A field that could only be
 * filled with something personal does not belong in an outcome.
 *
 * Kept to a closed vocabulary, like the audit log's actions, so a query can
 * rely on the names and adding one is a deliberate edit here.
 */

export const OUTCOMES = [
  "signin.completed",
  "signin.refused",
  "card.viewed",
  "membership.none",
  "pass.downloaded",
  "display_name.saved",
  "email_card.requested",
  "email_card.delivery",
  "claim.requested",
  "claim.confirmed",
  "pass.verified",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** Dimensions: short categorical values, never anything about who it was. */
export type OutcomeFields = Record<string, string | number | boolean>;

/**
 * Logs one outcome. A single object rather than a message plus fields, so
 * Workers Logs indexes every key, including `outcome`, as a queryable field.
 */
export function recordOutcome(outcome: Outcome, fields: OutcomeFields = {}): void {
  console.log({ outcome, ...fields });
}
