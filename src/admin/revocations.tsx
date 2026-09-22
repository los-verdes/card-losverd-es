/**
 * Every membership currently revoked, and everybody currently expelled (#31).
 *
 * A list rather than a search: both are rare, and the question this page
 * answers is "who is on it, and why" rather than "is this one person".
 * Revoking happens from that member's own page, which already knows how to
 * find somebody from a card number, an address or an order.
 *
 * It exists chiefly so the list is short and visible. A revocation is a
 * decision about a person that somebody will be asked to justify later, and
 * one that leaves no trace on the member's own screens once lifted -- a page
 * that can be read in ten seconds is most of what keeps that accountable.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { restoreCard, revokedCards, type RevokedCard } from "../member/revocation";
import { expelledPeople, readmitPerson, type ExpelledPerson } from "../member/expulsion";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";

const revocations = new Hono<AuthEnv & { Bindings: Env }>();
revocations.use("*", requireAdmin);
// `no-store`, like every other admin page: names, addresses and the reason
// somebody's membership was taken away.
revocations.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

export const REVOCATIONS_PATH = "/admin/revocations";

const Row: FC<{ card: RevokedCard }> = ({ card }) => (
  <tr>
    <td style={cellStyle}>
      <a href={`/admin/members?q=${encodeURIComponent(card.member_id)}`}>
        {card.member_id}
      </a>
    </td>
    <td style={cellStyle}>{card.email}</td>
    <td style={cellStyle}>{new Date(card.revoked_at).toISOString().slice(0, 10)}</td>
    <td style={cellStyle}>{card.revoked_by_email ?? "unknown"}</td>
    <td style={cellStyle}>{card.note ?? ""}</td>
    <td style={cellStyle}>
      <form method="post" action={REVOCATIONS_PATH}>
        <input type="hidden" name="member_id" value={card.member_id} />
        <button type="submit">Restore</button>
      </form>
    </td>
  </tr>
);

const ExpulsionRow: FC<{ person: ExpelledPerson }> = ({ person }) => (
  <tr>
    <td style={cellStyle}>
      <a href={`/admin/members?q=${encodeURIComponent(person.email)}`}>{person.email}</a>
    </td>
    <td style={cellStyle}>{new Date(person.expelled_at).toISOString().slice(0, 10)}</td>
    <td style={cellStyle}>{person.expelled_by_email ?? "unknown"}</td>
    <td style={cellStyle}>{person.has_membership ? "yes" : "no"}</td>
    <td style={cellStyle}>{person.note ?? ""}</td>
    <td style={cellStyle}>
      <form method="post" action={REVOCATIONS_PATH}>
        <input type="hidden" name="email" value={person.email} />
        <input type="hidden" name="action" value="readmit" />
        <button type="submit">Lift</button>
      </form>
    </td>
  </tr>
);

revocations.get("/", async (c) => {
  const [cards, expelled] = await Promise.all([revokedCards(c.env), expelledPeople(c.env)]);
  return c.html(
    <AdminPage title="Revoked and expelled">
      <h2>Revoked memberships</h2>
      <p>
        Memberships taken away before they expired. Each card reads as expired,
        its passes have been told, and its holder cannot reach the member area.
        The orders behind each one are untouched, so restoring puts the
        membership back to whatever those say.
      </p>
      <p>
        Revoking one happens from that member's page --{" "}
        <a href="/admin/members">find a member</a> by the card number on their
        pass, their address, or an order number.
      </p>
      {c.req.query("saved") === "restored" && (
        <p style="color: var(--success)">Membership restored.</p>
      )}
      {c.req.query("saved") === "readmitted" && (
        <p style="color: var(--success)">
          Expulsion lifted. Any membership it was suppressing is back.
        </p>
      )}
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {cards.length === 0 ? (
        <p>No membership has been revoked.</p>
      ) : (
        <div style="overflow-x: auto">
          <table style="border-collapse: collapse; font-size: 0.9rem">
            <thead>
              <tr>
                {["Card #", "Member", "Revoked", "By", "Why", ""].map((h) => (
                  <th style={cellStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <Row card={card} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Expelled from the group</h2>
      <p>
        Heavier and rarer than revoking a card: these people cannot sign in
        at all, and any membership they hold is suppressed while the expulsion
        stands. An expulsion carries no end date on purpose -- one that ran out
        on its own would put somebody back in without anybody deciding they
        should be.
        Lifting one restores whatever membership it was suppressing.
      </p>
      {expelled.length === 0 ? (
        <p>Nobody has been expelled.</p>
      ) : (
        <div style="overflow-x: auto">
          <table style="border-collapse: collapse; font-size: 0.9rem">
            <thead>
              <tr>
                {["Person", "Expelled", "By", "Holds a membership", "Why", ""].map((h) => (
                  <th style={cellStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expelled.map((person) => (
                <ExpulsionRow person={person} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>,
  );
});

revocations.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody();
  const memberId = typeof form.member_id === "string" ? form.member_id.trim() : "";
  const back = (params: Record<string, string>) =>
    c.redirect(`${REVOCATIONS_PATH}?${new URLSearchParams(params)}`, 303);

  if (form.action === "readmit") {
    const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
    if (!email) return back({ error: "No expulsion to lift." });
    return (await readmitPerson(c.env, email, c.get("session").userId))
      ? back({ saved: "readmitted" })
      : back({ error: "That person has not been expelled." });
  }

  if (!memberId) return back({ error: "No card to restore." });
  return (await restoreCard(c.env, memberId, c.get("session").userId))
    ? back({ saved: "restored" })
    : back({ error: "That card has not been revoked." });
});

export default revocations;
