/**
 * What has been done to memberships, most recent first.
 *
 * The other admin screens answer "what is true about this person now". This
 * one answers "what happened, and who decided it", which is a different
 * question and often asked about something that is no longer true -- an
 * expulsion since lifted, a name since changed back. Those leave no trace on
 * any other screen, because undoing them deletes the row.
 *
 * One person's history lives on their member page (#359), where it sits with
 * their card and orders: someone looking at what was done to a member
 * usually wants the whole story. Every address here links there, and an
 * old `?email=` link is sent there too. This page is the recent-activity
 * view: a page at a time, deliberately, since a page nobody can read at a
 * glance is a page nobody reads, with "Older entries" to go further back
 * (#319).
 *
 * All of it, or one person's, downloads as CSV. Each download is itself
 * recorded, because the file carries names, addresses and the reasons for
 * decisions out of the admin pages.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import {
  AUDIT_ACTION_LABELS,
  actorEmail,
  auditActor,
  readAuditLog,
  readWholeAuditLog,
  recordAuditEvent,
  type AuditEntry,
} from "../audit/log";
import { toCsv } from "../lib/csv";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";

export const AUDIT_PATH = "/admin/audit";

/** Entries per page. */
export const AUDIT_PAGE_SIZE = 100;

const audit = new Hono<AuthEnv & { Bindings: Env }>();
audit.use("*", requireAdmin);
// `no-store`, like every other admin page: this one is names, addresses and
// the reasons decisions were made about people.
audit.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/** Date and time, because two entries on one day is the case worth ordering. */
function formatWhen(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** Where one person's history is: the section of that name on their member page. */
export function memberHistoryHref(email: string): string {
  // Spelled out rather than imported: the members page imports this one.
  return `/admin/members?q=${encodeURIComponent(email)}#history`;
}

/** A member's page, by their address. */
function memberHref(email: string): string {
  return `/admin/members?q=${encodeURIComponent(email)}`;
}

/** D1 accepts at most 100 bound parameters a statement. */
const MEMBER_LOOKUP_CHUNK = 90;

/** Who an actor address belongs to, as far as this site knows. */
export interface ActorIdentity {
  /** The name to show: their card's name if they hold a membership, else their account's. */
  name: string | null;
  /** Whether they hold a membership, so there is a member page to link to. */
  member: boolean;
}

/**
 * Names for these entries' actors, so "Who did it" reads as people rather
 * than addresses: the name on their card when they hold a membership (the one
 * they chose, else their orders'), otherwise the name on their account, which
 * is how an admin with no membership is known. An address with neither is
 * shown as written.
 */
export async function actorDirectory(env: Env, entries: readonly AuditEntry[]): Promise<Map<string, ActorIdentity>> {
  const actors = [...new Set(entries.map((entry) => entry.actor_email).filter((email): email is string => Boolean(email)))];
  const directory = new Map<string, ActorIdentity>();
  for (let i = 0; i < actors.length; i += MEMBER_LOOKUP_CHUNK) {
    const chunk = actors.slice(i, i + MEMBER_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const [users, members] = await env.DB.batch<{ email: string; name: string | null }>([
      env.DB.prepare(
        `SELECT email, COALESCE(NULLIF(TRIM(full_name), ''), NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')) AS name
           FROM users WHERE email IN (${placeholders})`,
      ).bind(...chunk),
      env.DB.prepare(
        `SELECT m.email, COALESCE(d.display_name, NULLIF(TRIM(COALESCE(m.first_name, '') || ' ' || COALESCE(m.last_name, '')), '')) AS name
           FROM members m LEFT JOIN member_display_names d ON d.email = m.email
          WHERE m.email IN (${placeholders})`,
      ).bind(...chunk),
    ]);
    for (const { email, name } of users.results) directory.set(email, { name, member: false });
    for (const { email, name } of members.results) {
      directory.set(email, { name: name ?? directory.get(email)?.name ?? null, member: true });
    }
  }
  return directory;
}

const Row: FC<{ entry: AuditEntry; showSubject: boolean; actors: ReadonlyMap<string, ActorIdentity> }> = ({
  entry,
  showSubject,
  actors,
}) => (
  <tr>
    <td style={cellStyle}>{formatWhen(entry.created_at)}</td>
    <td style={cellStyle}>{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</td>
    {showSubject && (
      <td style={cellStyle}>
        {entry.subject_email ? <a href={memberHistoryHref(entry.subject_email)}>{entry.subject_email}</a> : ""}
      </td>
    )}
    <td style={cellStyle}>{entry.detail}</td>
    <td style={cellStyle}>
      <Actor entry={entry} actors={actors} />
    </td>
  </tr>
);

/**
 * A person by name (`actorDirectory`), their address on hover, and a link to
 * their member page when they hold a membership; an address nobody has a name
 * for, as written. What acted when no person did (`auditActor`) is muted, so
 * it reads as a description rather than an account to look up.
 */
const Actor: FC<{ entry: AuditEntry; actors: ReadonlyMap<string, ActorIdentity> }> = ({ entry, actors }) => {
  const actor = auditActor(entry);
  if (!actor.person) return <span class="muted">{actor.text}</span>;
  const known = actors.get(actor.text);
  const label = known?.name ?? actor.text;
  if (known?.member) return <a href={memberHref(actor.text)} title={actor.text}>{label}</a>;
  return known?.name ? <span title={actor.text}>{label}</span> : <>{label}</>;
};

const HISTORY_HEADINGS = ["When (UTC)", "What", "Detail", "Who did it"];

/**
 * One person's whole history, newest first, for their member page: every
 * entry, since one person's fits on a page where everyone's would not. It
 * includes what has since been undone, which no other part of that page
 * shows. Their CSV stays a link away.
 */
export const AuditHistory: FC<{ email: string; entries: AuditEntry[]; actors: ReadonlyMap<string, ActorIdentity> }> = ({
  email,
  entries,
  actors,
}) => (
  <section id="history">
    <h3>History</h3>
    <p class="muted">
      Everything recorded about this address, including decisions since undone.{" "}
      <a href={auditHref(email, { format: "csv" })}>Download it as CSV</a> (the download is itself recorded).
    </p>
    {entries.length === 0 ? (
      <p>Nothing has been recorded about this address.</p>
    ) : (
      <div style="overflow-x: auto">
        <table style="border-collapse: collapse; font-size: 0.9rem">
          <thead>
            <tr>
              {HISTORY_HEADINGS.map((h) => (
                <th style={cellStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <Row entry={entry} showSubject={false} actors={actors} />
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

/** The page's own address, keeping the filter and adding whatever else is asked. */
function auditHref(email: string | null, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...(email ? { email } : {}), ...params }).toString();
  return query ? `${AUDIT_PATH}?${query}` : AUDIT_PATH;
}

/** A positive whole number, or nothing: an old or mangled link shows the newest page rather than an error. */
function parseBefore(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
}

const CSV_COLUMNS = ["id", "when_utc", "action", "what", "who_it_was_about", "detail", "who_did_it", "who_did_it_name"] as const;

audit.get("/", async (c) => {
  const email = c.req.query("email")?.trim().toLowerCase() || null;

  if (c.req.query("format") === "csv") {
    const entries = await readWholeAuditLog(c.env, { email });
    const actors = await actorDirectory(c.env, entries);
    // Recorded before the file goes out, and allowed to fail the download: an
    // export nobody can see happened is the thing this log exists to prevent.
    await recordAuditEvent(c.env, {
      action: "audit_log.exported",
      subjectEmail: email,
      actorEmail: await actorEmail(c.env, c.get("session").userId),
      detail: `Downloaded ${entries.length} ${entries.length === 1 ? "entry" : "entries"}${email ? ` for ${email}` : ""}`,
    });
    const rows = entries.map((entry) => ({
      id: entry.id,
      when_utc: new Date(entry.created_at).toISOString(),
      action: entry.action,
      what: AUDIT_ACTION_LABELS[entry.action] ?? entry.action,
      who_it_was_about: entry.subject_email,
      detail: entry.detail,
      who_did_it: auditActor(entry).text || null,
      who_did_it_name: (entry.actor_email && actors.get(entry.actor_email)?.name) || null,
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(toCsv(CSV_COLUMNS, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
      },
    });
  }

  // One person's history is on their member page now; an old link lands there.
  if (email) return c.redirect(memberHistoryHref(email), 303);

  const before = parseBefore(c.req.query("before"));
  // One more than a page, to know whether there is an older one.
  const fetched = await readAuditLog(c.env, { before, limit: AUDIT_PAGE_SIZE + 1 });
  const entries = fetched.slice(0, AUDIT_PAGE_SIZE);
  const olderHref =
    fetched.length > AUDIT_PAGE_SIZE ? auditHref(null, { before: String(entries[entries.length - 1].id) }) : null;
  const headings = ["When (UTC)", "What", "Who it was about", "Detail", "Who did it"];
  const actors = await actorDirectory(c.env, entries);

  return c.html(
    <AdminPage title="Audit log">
      <p>
        Decisions people have made about memberships: revocations and
        expulsions and the lifting of them, card names, "member since"
        corrections, re-attributed orders, and every card email sent. Nothing
        is ever removed from this list, which is the point of it -- undoing a
        decision removes it from every other screen.
      </p>
      <p class="muted">
        {before === null ? "The most recent entries, a page at a time." : "Older entries."} Follow an
        address to see that person's whole history on their member page.
      </p>
      <p>
        <a href={auditHref(null, { format: "csv" })}>Download the whole log as CSV</a>{" "}
        <span class="muted">(the download is itself recorded here)</span>
      </p>
      {entries.length === 0 ? (
        <p>
          {before !== null ? "Nothing older than that." : "Nothing recorded yet."}
        </p>
      ) : (
        <div style="overflow-x: auto">
          <table style="border-collapse: collapse; font-size: 0.9rem">
            <thead>
              <tr>
                {headings.map((h) => (
                  <th style={cellStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Row entry={entry} showSubject actors={actors} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(olderHref || before !== null) && (
        <p>
          {before !== null && <a href={AUDIT_PATH}>Newest entries</a>}
          {before !== null && olderHref && " · "}
          {olderHref && <a href={olderHref}>Older entries</a>}
        </p>
      )}
    </AdminPage>,
  );
});

export default audit;
