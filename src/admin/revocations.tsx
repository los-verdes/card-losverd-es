/**
 * Every membership currently withdrawn (#31).
 *
 * A list rather than a search: withdrawals are rare, and the question this
 * page answers is "who is on it, and why" rather than "is this one person".
 * Withdrawing happens from that member's own page, which already knows how
 * to find somebody from a card number, an address or an order.
 *
 * It exists chiefly so the list is short and visible. A withdrawal is a
 * decision about a person that somebody will be asked to justify later, and
 * one that leaves no trace on the member's own screens once lifted -- a page
 * that can be read in ten seconds is most of what keeps that accountable.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { restoreCard, revokedCards, type RevokedCard } from "../member/revocation";
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

revocations.get("/", async (c) => {
  const cards = await revokedCards(c.env);
  return c.html(
    <AdminPage title="Withdrawn memberships">
      <p>
        Memberships taken away before they expired. Each card reads as expired,
        its passes have been told, and its holder cannot reach the member area.
        The orders behind each one are untouched, so restoring puts the
        membership back to whatever those say.
      </p>
      <p>
        Withdrawing one happens from that member's page --{" "}
        <a href="/admin/members">find a member</a> by the card number on their
        pass, their address, or an order number.
      </p>
      {c.req.query("saved") === "restored" && (
        <p style="color: var(--success)">Membership restored.</p>
      )}
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {cards.length === 0 ? (
        <p>No membership has been withdrawn.</p>
      ) : (
        <div style="overflow-x: auto">
          <table style="border-collapse: collapse; font-size: 0.9rem">
            <thead>
              <tr>
                {["Card #", "Member", "Withdrawn", "By", "Why", ""].map((h) => (
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
    </AdminPage>,
  );
});

revocations.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody();
  const memberId = typeof form.member_id === "string" ? form.member_id.trim() : "";
  const back = (params: Record<string, string>) =>
    c.redirect(`${REVOCATIONS_PATH}?${new URLSearchParams(params)}`, 303);

  if (!memberId) return back({ error: "No card to restore." });
  return (await restoreCard(c.env, memberId))
    ? back({ saved: "restored" })
    : back({ error: "That card was not withdrawn." });
});

export default revocations;
