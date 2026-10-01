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
import { AdminPage, MemberLink, cellStyle } from "./layout";
import { When } from "./when";

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

/** Where one person's history is: the section of that name on their member page. */
export function memberHistoryHref(email: string): string {
  // Spelled out rather than imported: the members page imports this one.
  return `/admin/members?q=${encodeURIComponent(email)}#history`;
}

/** A member's page, by their address. */
function memberHref(email: string): string {
  return `/admin/members?q=${encodeURIComponent(email)}`;
}

/**
 * The detail is free text and can run long, so it wraps within a width rather
 * than taking the admin tables' usual no-wrap, which pushed every column after
 * it off the page.
 */
const detailCellStyle = `${cellStyle}; white-space: normal; min-width: 14rem; max-width: 32rem; overflow-wrap: anywhere`;

const Row: FC<{ entry: AuditEntry; showSubject: boolean }> = ({ entry, showSubject }) => (
  // Top-aligned, so the other cells sit level with a wrapped detail's first line.
  <tr style="vertical-align: top">
    {/* Date and time, because two entries on one day is the case worth ordering. */}
    <td style={cellStyle}>
      <When at={entry.created_at} />
    </td>
    <td style={cellStyle}>{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</td>
    {showSubject && (
      <td style={cellStyle}>
        {entry.subject_email ? <MemberLink email={entry.subject_email} href={memberHistoryHref(entry.subject_email)} /> : ""}
      </td>
    )}
    <td style={detailCellStyle}>{entry.detail}</td>
    <td style={cellStyle}>
      <Actor entry={entry} />
    </td>
  </tr>
);

/**
 * A person by name (`AuditEntry.actor_name`), their address on hover, and a
 * link to their member page when they hold a membership; an address nobody
 * has a name for, as written. What acted when no person did (`auditActor`)
 * is muted, so it reads as a description rather than an account to look up.
 */
const Actor: FC<{ entry: AuditEntry }> = ({ entry }) => {
  const actor = auditActor(entry);
  if (!actor.person) return <span class="muted">{actor.text}</span>;
  const label = entry.actor_name ?? actor.text;
  if (entry.actor_is_member) return <a href={memberHref(actor.text)} title={actor.text}>{label}</a>;
  return entry.actor_name ? <span title={actor.text}>{label}</span> : <>{label}</>;
};

const HISTORY_HEADINGS = ["When", "What", "Detail", "Who did it"];

/**
 * One person's whole history, newest first, for their member page: every
 * entry, since one person's fits on a page where everyone's would not. It
 * includes what has since been undone, which no other part of that page
 * shows. Their CSV stays a link away.
 */
export const AuditHistory: FC<{ email: string; entries: AuditEntry[] }> = ({ email, entries }) => (
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
              <Row entry={entry} showSubject={false} />
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
      who_did_it_name: entry.actor_name,
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
  const headings = ["When", "What", "Who it was about", "Detail", "Who did it"];

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
                <Row entry={entry} showSubject />
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
