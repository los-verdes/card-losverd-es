/**
 * Moving every order attributed to one address to another at once: a member
 * whose older orders carry an address they no longer use, which would
 * otherwise mean attributing each order from its own page with the same
 * address and note. Two steps, like attributing one order
 * (src/admin/orders.tsx): entering the address shows everywhere it already
 * appears, then confirming moves exactly the orders that were listed.
 *
 * Every response is `no-store`: these pages show members' names and emails.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import { emailMemberCard } from "../email/card";
import { recipientWithheldNotice } from "../email/send";
import type { Env } from "../index";
import { isWellFormedEmail } from "../member/email-card";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import {
  attributeOrders,
  emailFootprint,
  listAttributableOrders,
  type AttributableOrder,
} from "./attribution";
import { AdminPage, MemberLink, cellStyle } from "./layout";
import { Footprint, MAX_NOTE_LENGTH, OrderLink } from "./orders";

export const MOVE_ORDERS_PATH = "/admin/move-orders";

export function moveOrdersPath(params: Record<string, string>): string {
  return `${MOVE_ORDERS_PATH}?${new URLSearchParams(params)}`;
}

type MoveInput = { to: string; note: string | null } | { error: string };

/** Validates a proposed move; `to` comes back trimmed and lowercased. */
function parseMove(from: string, rawTo: unknown, rawNote: unknown): MoveInput {
  const to = typeof rawTo === "string" ? rawTo.trim().toLowerCase() : "";
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (!isWellFormedEmail(to)) return { error: "Enter a valid email address." };
  if (to === from) return { error: `These orders are already attributed to ${to}.` };
  if (note.length > MAX_NOTE_LENGTH) return { error: `Keep the note under ${MAX_NOTE_LENGTH} characters.` };
  return { to, note: note || null };
}

const OrderList: FC<{ orders: AttributableOrder[] }> = ({ orders }) => (
  <table style="border-collapse: collapse; font-size: 0.9rem; margin-bottom: 1rem">
    <thead>
      <tr>
        {["Order", "Placed with", "Status", "Placed", "Counts"].map((heading) => (
          <th style={cellStyle}>{heading}</th>
        ))}
      </tr>
    </thead>
    <tbody>
      {orders.map((order) => (
        <tr>
          <td style={cellStyle}>
            <OrderLink orderId={order.order_id} />
          </td>
          <td style={cellStyle}>{order.order_email}</td>
          <td style={cellStyle}>{order.status ?? ""}</td>
          <td style={cellStyle}>{order.created_on.slice(0, 10)}</td>
          <td style={cellStyle}>{order.counts ? "yes" : "no"}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const moveOrders = new Hono<AuthEnv & { Bindings: Env }>();

moveOrders.use("*", requireAdmin);
moveOrders.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

moveOrders.get("/", async (c) => {
  const from = c.req.query("from")?.trim().toLowerCase() ?? "";
  if (!isWellFormedEmail(from)) {
    return c.html(
      <AdminPage title="Move orders">
        <p>Start from a member's page: their orders end with a link to move them all to another address.</p>
      </AdminPage>,
      400,
    );
  }

  const movedTo = c.req.query("moved_to");
  if (movedTo) {
    const [toFootprint, fromFootprint] = await Promise.all([
      emailFootprint(c.env.DB, movedTo),
      emailFootprint(c.env.DB, from),
    ]);
    return c.html(
      <AdminPage title="Orders moved">
        <section style="border: 1px solid var(--verde); padding: 0.5rem 1rem; margin-bottom: 1rem">
          <p>
            Moved {c.req.query("count")} order(s) from {from} to <strong>{movedTo}</strong>.
            {c.req.query("emailed") === "1" && " Their card is on its way by email."} Their cards now:
          </p>
          {c.req.query("email_withheld") === "1" && (
            <p style="color: var(--warn)">
              Their card was not emailed. {recipientWithheldNotice(c.env.EMAIL_RECIPIENT_ALLOWLIST, movedTo, { showList: true })}
            </p>
          )}
          <Footprint email={movedTo} footprint={toFootprint} />
          <Footprint email={from} footprint={fromFootprint} />
        </section>
        <p>
          <MemberLink email={movedTo} /> · <MemberLink email={from} />
        </p>
      </AdminPage>,
    );
  }

  const orders = await listAttributableOrders(c.env.DB, from);
  const proposed = c.req.query("to") === undefined ? null : parseMove(from, c.req.query("to"), c.req.query("note"));
  const review = proposed && "to" in proposed ? { ...proposed, footprint: await emailFootprint(c.env.DB, proposed.to) } : null;
  const withheld = review && recipientWithheldNotice(c.env.EMAIL_RECIPIENT_ALLOWLIST, review.to, { showList: true });
  const back = `/admin/members?q=${encodeURIComponent(from)}`;

  return c.html(
    <AdminPage title={`Move every order from ${from}`}>
      <p class="muted">
        Every order attributed to <MemberLink email={from} />, moved to another address at once, as if each were
        attributed from its own page: each keeps its own history, and both people's cards are worked out again.
      </p>
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {orders.length === 0 ? (
        <p>No orders are attributed to this address.</p>
      ) : review ? (
        <form method="post" action={MOVE_ORDERS_PATH}>
          <p>Move these {orders.length} order(s):</p>
          <OrderList orders={orders} />
          <p>to:</p>
          <Footprint email={review.to} footprint={review.footprint} />
          {review.note && <p>Note: {review.note}</p>}
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={review.to} />
          <input type="hidden" name="note" value={review.note ?? ""} />
          {orders.map((order) => (
            <input type="hidden" name="order" value={order.order_id} />
          ))}
          <p>
            <label>
              <input type="checkbox" name="email_card" checked />
              {" Email them their card"}
            </label>
            {!orders.some((order) => order.counts) && " (nothing will be sent: none of these counts as a membership)"}
          </p>
          {withheld && <p style="color: var(--warn)">{withheld}</p>}
          <button type="submit">Confirm</button> <a href={moveOrdersPath({ from })}>Cancel</a>
        </form>
      ) : (
        <>
          <OrderList orders={orders} />
          <form method="get" action={MOVE_ORDERS_PATH}>
            {proposed && "error" in proposed && <p style="color: var(--danger)">{proposed.error}</p>}
            <input type="hidden" name="from" value={from} />
            <label for="move_to">Move them all to</label>
            <input id="move_to" type="email" name="to" required value={c.req.query("to") ?? ""} />
            <label for="move_note">
              Note<span class="hint">Optional · e.g. "address they no longer use"</span>
            </label>
            <input id="move_note" type="text" name="note" maxlength={MAX_NOTE_LENGTH} value={c.req.query("note") ?? ""} />
            <button type="submit">Review</button>
          </form>
        </>
      )}
      <p>
        <a href={back}>Back to {from}</a>
      </p>
    </AdminPage>,
    proposed && "error" in proposed ? 400 : 200,
  );
});

/**
 * Moves the orders the review listed, and only those still attributed to the
 * address they were listed under: an order that arrived, or was moved, after
 * the review is left alone rather than swept up unseen.
 */
moveOrders.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody({ all: true });
  const from = typeof form.from === "string" ? form.from.trim().toLowerCase() : "";
  const input = parseMove(from, form.to, form.note);
  if (!isWellFormedEmail(from) || "error" in input) {
    return c.text(`Bad Request: ${"error" in input ? input.error : "no address to move orders from."}`, 400);
  }
  const listed = new Set([form.order].flat().filter((id): id is string => typeof id === "string"));
  const orders = (await listAttributableOrders(c.env.DB, from)).filter((order) => listed.has(order.order_id));
  if (orders.length === 0) {
    return c.redirect(moveOrdersPath({ from, error: "None of those orders is attributed to this address any more." }), 303);
  }

  const { current } = await attributeOrders(c.env, orders, input.to, c.get("session").userId, input.note);
  // Only the new member, only when they have a card, only this once.
  const emailing = form.email_card === "on" && current !== null;
  const allowed = recipientWithheldNotice(c.env.EMAIL_RECIPIENT_ALLOWLIST, input.to, { showList: true }) === null;
  if (emailing && allowed) {
    c.executionCtx.waitUntil(emailMemberCard(c.env, input.to, { kind: "attribution" }));
  }
  const params: Record<string, string> = { from, moved_to: input.to, count: String(orders.length) };
  if (emailing) params[allowed ? "emailed" : "email_withheld"] = "1";
  return c.redirect(moveOrdersPath(params), 303);
});

export default moveOrders;
