/**
 * Correcting a member's "member since" date, as a section of their admin page.
 *
 * The date on a card is normally derived: the earliest order that counts
 * towards the member's membership. That is right for anyone whose history we
 * hold in full, and wrong for anyone whose earliest membership predates what
 * we can see -- the Squarespace years, a membership bought on someone else's
 * behalf, a paper record. A `member_since_overrides` row fixes those, and
 * wins wherever the date is read.
 *
 * The people who know that someone joined in 2016 are the Merch Team, who
 * answer the mail this arrives in, not whoever has database credentials, so
 * this is a form rather than a `wrangler d1 execute` one-liner. It is built
 * around showing the two dates apart -- the derived one and the override --
 * since the question a corrector is really answering is "is what we worked
 * out from the orders right?", and they cannot answer it without seeing both.
 *
 * It was a page of its own (`/admin/member-since`, which now redirects here)
 * until #331: an admin noticing a wrong date is already on the member's page,
 * and the list of every correction is on the Consolidations report.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate, parseIsoDate } from "../lib/dateFormat";
import { isWellFormedEmail } from "../member/email-card";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { cellStyle } from "./layout";
import { dayText } from "./when";
import { actorEmail, recordAuditEvent } from "../audit/log";

/** Spelled out rather than imported: the members page imports this one. */
const MEMBERS_PATH = "/admin/members";
const MAX_NOTE_LENGTH = 500;

/** The earliest date worth accepting; the group was founded well after this. */
const EARLIEST_PLAUSIBLE = "2000-01-01";

export interface MemberSinceSubject {
  email: string;
  /** What the orders say, which is what an override replaces. */
  derived: string | null;
  /** The override in force, if any. */
  override: {
    member_since: string;
    source: string;
    note: string | null;
    set_by_email: string | null;
    updated_at: number;
  } | null;
}

/**
 * Both halves of the answer. `members.member_since` is the order-derived
 * date; the shared member lookup has already folded any override into the
 * date it returns, so the derived one is read here on its own.
 */
export async function lookupMemberSince(env: Env, email: string): Promise<MemberSinceSubject> {
  const [member, override] = await Promise.all([
    env.DB.prepare("SELECT member_since FROM members WHERE email = ?")
      .bind(email)
      .first<{ member_since: string | null }>(),
    env.DB.prepare(
      // `set_by` is resolved to an address here: a user id on the screen
      // answers nobody's question about who moved somebody's join date.
      `SELECT o.member_since, o.source, o.note, o.updated_at, u.email AS set_by_email
         FROM member_since_overrides o
              LEFT JOIN users u ON u.id = o.set_by
        WHERE o.email = ?`,
    )
      .bind(email)
      .first<{
        member_since: string;
        source: string;
        note: string | null;
        set_by_email: string | null;
        updated_at: number;
      }>(),
  ]);
  return { email, derived: member?.member_since ?? null, override: override ?? null };
}

type Input = { email: string; date: string; note: string | null } | { error: string };

/**
 * `today` is passed in rather than read here so the rule ("not in the
 * future") is testable without waiting for tomorrow.
 */
export function parseMemberSince(
  rawEmail: unknown,
  rawDate: unknown,
  rawNote: unknown,
  today: string,
): Input {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const date = typeof rawDate === "string" ? rawDate.trim() : "";
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (!isWellFormedEmail(email)) return { error: "Enter a valid email address." };
  if (!parseIsoDate(date)) {
    // Says "a real date" rather than "the right shape" on purpose: 2021-02-30
    // is the right shape.
    return { error: "Enter a real date, as YYYY-MM-DD." };
  }
  if (date > today) return { error: "A member since date can't be in the future." };
  if (date < EARLIEST_PLAUSIBLE) {
    return { error: `That date is before ${EARLIEST_PLAUSIBLE}; check it for typos.` };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return { error: `Keep the note under ${MAX_NOTE_LENGTH} characters.` };
  }
  return { email, date, note: note || null };
}

/** The correction in force, read before a write: both writes destroy it, and the log line is the only place it survives. */
async function existingCorrection(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT member_since FROM member_since_overrides WHERE email = ?")
    .bind(email)
    .first<{ member_since: string }>();
  return row?.member_since ?? null;
}

/**
 * Records an admin's correction. `source = 'manual'` is what tells it apart
 * from a date the legacy import carried across, and what clearing looks for;
 * saving over an imported date makes it manual from then on.
 *
 * No pass push needed: the table's triggers bump the member's
 * `last_updated_at`, so their card and pass are rebuilt on next fetch.
 */
export async function saveMemberSince(
  env: Env,
  input: { email: string; date: string; note: string | null },
  userId: number,
): Promise<void> {
  const [existing, actor] = await Promise.all([existingCorrection(env, input.email), actorEmail(env, userId)]);
  await env.DB.prepare(
    `INSERT INTO member_since_overrides (email, member_since, source, note, set_by)
     VALUES (?, ?, 'manual', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       member_since = excluded.member_since,
       source = 'manual',
       note = excluded.note,
       set_by = excluded.set_by,
       updated_at = unixepoch('subsec') * 1000`,
  )
    .bind(input.email, input.date, input.note, userId)
    .run();
  await recordAuditEvent(env, {
    action: "member_since.set",
    subjectEmail: input.email,
    actorEmail: actor,
    detail: input.date + (existing ? ` (was ${existing})` : "") + (input.note ? ` -- ${input.note}` : ""),
  });
}

/**
 * Removes an admin's correction, so the card goes back to the date from the
 * orders. False when there was none to remove.
 *
 * Never removes an imported date. Those that matched the orders, or covered
 * no Squarespace-era order, were retired by migration 0016; any left is the
 * only record of a Squarespace-era membership, and the old site is gone. One
 * found to be wrong is corrected over (which makes it manual) or changed by
 * hand in the database (#331).
 */
export async function clearMemberSince(env: Env, email: string, userId: number): Promise<boolean> {
  const [existing, actor] = await Promise.all([existingCorrection(env, email), actorEmail(env, userId)]);
  const result = await env.DB.prepare("DELETE FROM member_since_overrides WHERE email = ? AND source = 'manual'")
    .bind(email)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await recordAuditEvent(env, {
    action: "member_since.cleared",
    subjectEmail: email,
    actorEmail: actor,
    detail: existing ? `Was ${existing}; back to what the orders say` : "Correction removed",
  });
  return true;
}

/** The section on a member's admin page. `today` caps the date picker. */
export const MemberSinceSection: FC<{ subject: MemberSinceSubject; today: string }> = ({ subject, today }) => {
  const { email, derived, override } = subject;
  const effective = override?.member_since ?? derived;
  return (
    <>
      <h3 id="member-since">Their &quot;member since&quot; date</h3>
      <p>
        Worked out from the earliest order that counts towards their membership. Where that is wrong -- a
        membership from before the current store, or one bought on someone else's behalf -- correct it here,
        and the correction wins wherever the date is shown.
      </p>
      <table style="border-collapse: collapse; margin-bottom: 1rem; font-size: 0.9rem">
        <tbody>
          <tr>
            <th style={cellStyle}>Showing on their card</th>
            <td style={cellStyle}>
              {effective ? formatShortDate(effective) : "nothing yet"}
              {override ? " (corrected)" : derived ? " (from their orders)" : ""}
            </td>
          </tr>
          <tr>
            <th style={cellStyle}>Worked out from their orders</th>
            <td style={cellStyle}>{derived ? formatShortDate(derived) : "no counting orders"}</td>
          </tr>
          {override && (
            <tr>
              <th style={cellStyle}>Correction on file</th>
              <td style={`${cellStyle}; white-space: normal; max-width: 32rem`}>
                {formatShortDate(override.member_since)} — set {dayText(override.updated_at)}
                {override.source === "legacy_postgres" ? ", imported from the old site" : ""}
                {override.set_by_email ? ` by ${override.set_by_email}` : ""}
                {override.note ? ` — ${override.note}` : ""}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <form method="post" action={MEMBERS_PATH}>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="action" value="member-since" />
        <label for="member_since">Correct it to</label>
        <input
          id="member_since"
          type="date"
          name="member_since"
          value={override?.member_since ?? derived ?? ""}
          max={today}
          required
        />
        <label for="member_since_note">
          Why<span class="hint">Optional · Kept on the record</span>
        </label>
        <input id="member_since_note" type="text" name="note" maxlength={MAX_NOTE_LENGTH} autocomplete="off" />
        <button type="submit">Save correction</button>
      </form>
      {override?.source === "manual" && (
        <form method="post" action={MEMBERS_PATH}>
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="action" value="member-since-clear" />
          <button type="submit">Use the date from their orders instead</button>
        </form>
      )}
      {override?.source === "legacy_postgres" && (
        <p class="muted">
          A date imported from the old site can be corrected but not removed: it is that site's record of when they
          joined, and could not be recovered.
        </p>
      )}
    </>
  );
};

/**
 * The page this section replaced. A link or bookmark to someone's dates lands
 * on that section of their member page; one without an address on the search.
 */
const memberSince = new Hono<AuthEnv & { Bindings: Env }>();

memberSince.use("*", requireAdmin);

memberSince.get("/", (c) => {
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  return c.redirect(
    isWellFormedEmail(email) ? `${MEMBERS_PATH}?${new URLSearchParams({ q: email })}#member-since` : MEMBERS_PATH,
    301,
  );
});

export default memberSince;
