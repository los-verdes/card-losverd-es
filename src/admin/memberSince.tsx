/**
 * Admin page for correcting a member's "member since" date.
 *
 * The date on a card is normally derived: the earliest order that counts
 * towards the member's membership. That is right for anyone whose history we
 * hold in full, and wrong for anyone whose earliest membership predates what
 * we can see -- the Squarespace years, a membership bought on someone else's
 * behalf, a paper record. A `member_since_overrides` row fixes those, and
 * wins wherever the date is read.
 *
 * The mechanism already existed and was documented as a `wrangler d1 execute`
 * one-liner, which makes it a developer's job. This page exists because it
 * shouldn't be: the people who know that someone joined in 2016 are the Merch
 * Team, who answer the mail this arrives in, not whoever has database
 * credentials.
 *
 * So the page is built around showing the two dates apart -- the derived one
 * and the override -- since the question a corrector is really answering is
 * "is what we worked out from the orders right?", and they cannot answer it
 * without seeing both.
 *
 * Every response is `no-store`: these pages show members' names and emails.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate, parseIsoDate } from "../lib/dateFormat";
import { isWellFormedEmail } from "../member/email-card";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";

export const MEMBER_SINCE_PATH = "/admin/member-since";
const MAX_NOTE_LENGTH = 500;

/** The earliest date worth accepting; the group was founded well after this. */
const EARLIEST_PLAUSIBLE = "2000-01-01";

export interface MemberSinceSubject {
  email: string;
  /** Null when no member row exists for this address yet. */
  member: { member_id: string; first_name: string; last_name: string } | null;
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
 * Both halves of the answer, looked up separately because an override can
 * exist for an address with no member row -- a correction can be recorded
 * before the order that creates the member has synced.
 */
export async function lookupMemberSince(
  env: Env,
  email: string,
): Promise<MemberSinceSubject> {
  const [member, override] = await Promise.all([
    env.DB.prepare(
      "SELECT member_id, first_name, last_name, member_since FROM members WHERE email = ?",
    )
      .bind(email)
      .first<{ member_id: string; first_name: string; last_name: string; member_since: string | null }>(),
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
  return {
    email,
    member: member
      ? { member_id: member.member_id, first_name: member.first_name, last_name: member.last_name }
      : null,
    derived: member?.member_since ?? null,
    override: override ?? null,
  };
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

const SearchForm: FC<{ email: string }> = ({ email }) => (
  <form method="get" action={MEMBER_SINCE_PATH} style="margin-bottom: 1.5rem">
    <label>
      Member's email address{" "}
      <input type="email" name="email" value={email} required style="min-width: 18rem" />
    </label>{" "}
    <button type="submit">Look up</button>
  </form>
);

const Subject: FC<{ subject: MemberSinceSubject; today: string; error?: string }> = ({
  subject,
  today,
  error,
}) => {
  const { email, member, derived, override } = subject;
  const effective = override?.member_since ?? derived;
  return (
    <section>
      <h2>
        {member ? `${member.first_name} ${member.last_name}`.trim() : email}
      </h2>
      {!member && (
        <p style="color: var(--danger)">
          No membership card exists for this address yet. A correction saved now will apply
          as soon as one does -- but check the address for typos first.
        </p>
      )}
      <table style="border-collapse: collapse; margin-bottom: 1rem">
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
              <td style={cellStyle}>
                {formatShortDate(override.member_since)} — set{" "}
                {new Date(override.updated_at).toISOString().slice(0, 10)}
                {override.source === "legacy_postgres" ? ", imported from the old site" : ""}
                {override.set_by_email ? ` by ${override.set_by_email}` : ""}
                {override.note ? ` — ${override.note}` : ""}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {error && <p style="color: var(--danger)">{error}</p>}

      <form method="post" action={MEMBER_SINCE_PATH}>
        <input type="hidden" name="email" value={email} />
        <p>
          <label>
            Correct it to{" "}
            <input
              type="date"
              name="member_since"
              value={override?.member_since ?? derived ?? ""}
              max={today}
              required
            />
          </label>
        </p>
        <p>
          <label>
            Why (optional, kept on the record)
            <br />
            <input type="text" name="note" maxlength={MAX_NOTE_LENGTH} style="min-width: 24rem" />
          </label>
        </p>
        <button type="submit" name="action" value="save">
          Save correction
        </button>{" "}
        {override && override.source !== "legacy_postgres" && (
          <button type="submit" name="action" value="clear">
            Remove correction, use their orders
          </button>
        )}
      </form>
    </section>
  );
};

const memberSince = new Hono<AuthEnv & { Bindings: Env }>();

memberSince.use("*", requireAdmin);
memberSince.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

memberSince.get("/", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  const saved = c.req.query("saved");
  const error = c.req.query("error");
  const subject = email && isWellFormedEmail(email) ? await lookupMemberSince(c.env, email) : null;
  return c.html(
    <AdminPage title="Member since dates">
      <p>
        A member's "member since" date is worked out from the earliest order that counts
        towards their membership. Where that is wrong -- a membership from before the
        current store, or one bought on someone else's behalf -- it can be corrected here,
        and the correction wins wherever the date is shown.
      </p>
      {saved === "set" && <p style="color: var(--success)">Correction saved. Their card will show it from now on.</p>}
      {saved === "cleared" && (
        <p style="color: var(--success)">Correction removed. Their card is back to the date from their orders.</p>
      )}
      <SearchForm email={email} />
      {email && !isWellFormedEmail(email) && <p style="color: var(--danger)">That doesn't look like an email address.</p>}
      {subject && <Subject subject={subject} today={today} error={error ?? undefined} />}
    </AdminPage>,
  );
});

memberSince.post("/", csrf(), async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
  const back = (params: Record<string, string>) =>
    c.redirect(`${MEMBER_SINCE_PATH}?${new URLSearchParams({ email, ...params })}`, 303);

  if (form.action === "clear") {
    // Never removes an imported date: that is the only surviving record of a
    // Squarespace-era membership, and the old site is gone (plan Phase 2.2).
    const result = await c.env.DB.prepare(
      "DELETE FROM member_since_overrides WHERE email = ? AND source = 'manual'",
    )
      .bind(email)
      .run();
    return (result.meta.changes ?? 0) > 0
      ? back({ saved: "cleared" })
      : back({ error: "There was no correction to remove." });
  }

  const input = parseMemberSince(form.email, form.member_since, form.note, today);
  if ("error" in input) {
    return back({ error: input.error });
  }
  // `source = 'manual'` is what makes this survive a re-run of the legacy
  // import, which only ever overwrites its own rows.
  await c.env.DB.prepare(
    `INSERT INTO member_since_overrides (email, member_since, source, note, set_by)
     VALUES (?, ?, 'manual', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       member_since = excluded.member_since,
       source = 'manual',
       note = excluded.note,
       set_by = excluded.set_by,
       updated_at = unixepoch('subsec') * 1000`,
  )
    .bind(input.email, input.date, input.note, c.get("session").userId)
    .run();
  // No pass push needed: the table's triggers bump the member's
  // `last_updated_at`, so their card and pass are rebuilt on next fetch.
  return back({ saved: "set" });
});

export default memberSince;
