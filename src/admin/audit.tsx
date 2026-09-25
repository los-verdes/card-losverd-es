/**
 * What has been done to memberships, most recent first.
 *
 * The other admin screens answer "what is true about this person now". This
 * one answers "what happened, and who decided it", which is a different
 * question and often asked about something that is no longer true -- an
 * expulsion since lifted, a name since changed back. Those leave no trace on
 * any other screen, because undoing them deletes the row.
 *
 * Filtered to one person by `?email=`, which is how the member page links
 * here. Unfiltered it is the recent-activity view: a page at a time,
 * deliberately, since a page nobody can read at a glance is a page nobody
 * reads, with "Older entries" to go further back (#319).
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

const Row: FC<{ entry: AuditEntry; showSubject: boolean }> = ({ entry, showSubject }) => (
  <tr>
    <td style={cellStyle}>{formatWhen(entry.created_at)}</td>
    <td style={cellStyle}>{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</td>
    {showSubject && (
      <td style={cellStyle}>
        {entry.subject_email ? (
          <a href={`${AUDIT_PATH}?email=${encodeURIComponent(entry.subject_email)}`}>
            {entry.subject_email}
          </a>
        ) : (
          ""
        )}
      </td>
    )}
    <td style={cellStyle}>{entry.detail}</td>
    {/* Blank rather than "system": an empty cell reads as "nobody", which is
        what it means, where a word invites the reader to look for an account
        by that name. */}
    <td style={cellStyle}>{entry.actor_email ?? ""}</td>
  </tr>
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

const CSV_COLUMNS = ["id", "when_utc", "action", "what", "who_it_was_about", "detail", "who_did_it"] as const;

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
      who_did_it: entry.actor_email,
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(toCsv(CSV_COLUMNS, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
      },
    });
  }

  const before = parseBefore(c.req.query("before"));
  // One more than a page, to know whether there is an older one.
  const fetched = await readAuditLog(c.env, { email, before, limit: AUDIT_PAGE_SIZE + 1 });
  const entries = fetched.slice(0, AUDIT_PAGE_SIZE);
  const olderHref =
    fetched.length > AUDIT_PAGE_SIZE ? auditHref(email, { before: String(entries[entries.length - 1].id) }) : null;
  const showSubject = email === null;
  const headings = showSubject
    ? ["When (UTC)", "What", "Who it was about", "Detail", "Who did it"]
    : ["When (UTC)", "What", "Detail", "Who did it"];

  return c.html(
    <AdminPage title={email ? `Audit log: ${email}` : "Audit log"}>
      <p>
        Decisions people have made about memberships: revocations and
        expulsions and the lifting of them, card names, "member since"
        corrections, re-attributed orders, and every card email sent. Nothing
        is ever removed from this list, which is the point of it -- undoing a
        decision removes it from every other screen.
      </p>
      {email ? (
        <p>
          <a href={AUDIT_PATH}>Everything, not just this person</a> ·{" "}
          <a href={`/admin/members?q=${encodeURIComponent(email)}`}>Their member page</a>
        </p>
      ) : (
        <p class="muted">
          {before === null ? "The most recent entries, a page at a time." : "Older entries."} Follow an
          address to see one person's history on its own.
        </p>
      )}
      <p>
        <a href={auditHref(email, { format: "csv" })}>
          {email ? "Download their whole history as CSV" : "Download the whole log as CSV"}
        </a>{" "}
        <span class="muted">(the download is itself recorded here)</span>
      </p>
      {entries.length === 0 ? (
        <p>
          {before !== null
            ? "Nothing older than that."
            : email
              ? "Nothing has been recorded against this address."
              : "Nothing recorded yet."}
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
                <Row entry={entry} showSubject={showSubject} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(olderHref || before !== null) && (
        <p>
          {before !== null && <a href={auditHref(email)}>Newest entries</a>}
          {before !== null && olderHref && " · "}
          {olderHref && <a href={olderHref}>Older entries</a>}
        </p>
      )}
    </AdminPage>,
  );
});

export default audit;
