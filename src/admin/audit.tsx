/**
 * What has been done to memberships, most recent first (migration 0020).
 *
 * The other admin screens answer "what is true about this person now". This
 * one answers "what happened, and who decided it", which is a different
 * question and often asked about something that is no longer true -- an
 * expulsion since lifted, a name since changed back. Those leave no trace on
 * any other screen, because undoing them deletes the row.
 *
 * Filtered to one person by `?email=`, which is how the member page links
 * here. Unfiltered it is the recent-activity view: short, deliberately, since
 * a page nobody can read at a glance is a page nobody reads.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { AUDIT_ACTION_LABELS, readAuditLog, type AuditEntry } from "../audit/log";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";

export const AUDIT_PATH = "/admin/audit";

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

audit.get("/", async (c) => {
  const email = c.req.query("email")?.trim().toLowerCase() || null;
  const entries = await readAuditLog(c.env, { email });
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
          The most recent {entries.length === 0 ? "entries" : `${entries.length}`}. Follow an
          address to see one person's history on its own.
        </p>
      )}
      {entries.length === 0 ? (
        <p>{email ? "Nothing has been recorded against this address." : "Nothing recorded yet."}</p>
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
    </AdminPage>,
  );
});

export default audit;
