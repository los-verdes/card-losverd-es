/**
 * Admin page for one membership order: its details, attribution history, and
 * the form to attribute it to someone other than its purchaser
 * (los-verdes/card-losverd-es#70). Attributing is two steps: entering an
 * address shows everywhere that address already appears (instead of asking
 * for it twice), then confirming POSTs the change.
 *
 * Every response is `no-store`: these pages show members' names and emails.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";
import { isMembershipCurrent } from "../member/artifacts";
import { isWellFormedEmail } from "../member/email-card";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { emailMemberCard } from "../email/card";
import { readOrderFromStore } from "../bigcommerce/sync";
import { recordOutcome } from "../lib/outcome";
import { toIsoSeconds } from "../bigcommerce/orders";
import {
  attributeOrder,
  emailFootprint,
  getAttributableOrder,
  listAttributions,
  type AttributableOrder,
  type AttributionRecord,
  type EmailFootprint,
} from "./attribution";
import { AdminPage, MemberLink, cellStyle } from "./layout";

const MAX_NOTE_LENGTH = 500;

export function orderPath(orderId: string): string {
  return `/admin/orders/${encodeURIComponent(orderId)}`;
}

/**
 * Re-reading one order from BigCommerce (#294). Rarely needed -- the order
 * webhook brings changes in within seconds, and the resync catches what it
 * misses -- but there for an admin who wants to be sure, or whose member's
 * record looks wrong. What the admin is told afterwards, by outcome.
 */
export const REREAD_MESSAGES = {
  updated: "Re-read from BigCommerce. It had changed, and the membership is now up to date.",
  unchanged: "Re-read from BigCommerce. Nothing had changed.",
  missing: 'BigCommerce no longer returns this order. It still counts, and is listed under "Missing from BigCommerce".',
  "no-membership": "BigCommerce's copy of this order carries no membership, so nothing was changed.",
  unreachable: "Could not finish reading it from BigCommerce. Try again shortly; a re-read is always safe to repeat.",
} as const;

export type RereadResult = keyof typeof REREAD_MESSAGES;

export function rereadMessage(value: string | undefined): string | null {
  return value !== undefined && value in REREAD_MESSAGES ? REREAD_MESSAGES[value as RereadResult] : null;
}

/** Only BigCommerce orders have a store to re-read; Squarespace-era ones carry a stored verdict. */
export const RereadButton: FC<{ orderId: string; from: "member" | "order" }> = ({ orderId, from }) => (
  <form method="post" action={`${orderPath(orderId)}/reread`} style="display: inline">
    <input type="hidden" name="from" value={from} />
    <button type="submit" data-busy-label="Re-reading…">
      Re-read from BigCommerce
    </button>
  </form>
);

type AttributionInput = { email: string; note: string | null } | { error: string };

/** Validates a proposed attribution; `email` comes back trimmed and lowercased. */
function parseAttribution(order: AttributableOrder, rawEmail: unknown, rawNote: unknown): AttributionInput {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (!isWellFormedEmail(email)) return { error: "Enter a valid email address." };
  if (email === order.member_email) return { error: `This order is already attributed to ${email}.` };
  if (note.length > MAX_NOTE_LENGTH) return { error: `Keep the note under ${MAX_NOTE_LENGTH} characters.` };
  return { email, note: note || null };
}

const Footprint: FC<{ email: string; footprint: EmailFootprint }> = ({ email, footprint }) => {
  const { member, memberOrders, placedOrders, login, slack } = footprint;
  const nowhere = !member && memberOrders.total === 0 && placedOrders === 0 && !login && !slack;
  return (
    <div>
      <p>
        <strong>{email}</strong>
      </p>
      {nowhere && (
        <p style="color: var(--danger)">
          This address doesn't appear anywhere yet (no card, orders, login, or Slack account). Check it for typos.
        </p>
      )}
      <ul>
        <li>
          {!member
            ? "No member card"
            : member.expiration_date && isMembershipCurrent(member)
              ? `Member card, current through ${formatShortDate(member.expiration_date)}`
              : "Member card, but no current membership"}
        </li>
        <li>
          {memberOrders.total} order(s) attributed to this address ({memberOrders.counted} counting as memberships);{" "}
          {placedOrders} placed with it
        </li>
        <li>{!login ? "Has never logged in" : login.is_admin === 1 ? "Has logged in (admin)" : "Has logged in"}</li>
        <li>{!slack ? "No Slack account" : `Slack: ${slack.handle ?? slack.slack_id}${slack.deleted ? " (deactivated)" : ""}`}</li>
      </ul>
    </div>
  );
};

const OrderDetails: FC<{ order: AttributableOrder }> = ({ order }) => (
  <table style="border-collapse: collapse; font-size: 0.9rem; margin-bottom: 1rem">
    <tbody>
      {(
        [
          ["Order", order.order_id],
          ["Source", order.source],
          ["Name", `${order.first_name ?? ""} ${order.last_name ?? ""}`.trim()],
          // Linked only when it differs: the same address twice is one member.
          [
            "Order email",
            order.order_email !== order.member_email ? (
              <MemberLink email={order.order_email} />
            ) : (
              order.order_email
            ),
          ],
          ["Attributed to", <MemberLink email={order.member_email} />],
          ["Started", order.created_on.slice(0, 10)],
          ["Expires", order.expires_on.slice(0, 10)],
          ["Status", `${order.status ?? ""}${order.counts ? "" : " (doesn't count as a membership)"}`],
          ...(order.membership_units && order.membership_units > 1
            ? ([
                [
                  "Memberships",
                  // The report lists only orders whose membership is still active (#324), so it is
                  // only pointed at while this one is.
                  `Carried ${order.membership_units} memberships; only this one was recorded. ` +
                    (order.counts && order.expires_on > toIsoSeconds(new Date())
                      ? 'See the "More than one membership" report.'
                      : "It no longer counts or has expired, so nobody is owed a card for it any more."),
                ],
              ] as const)
            : []),
          ...(order.missing_since
            ? ([
                [
                  "In BigCommerce",
                  `No longer returned by the store, first noticed ${new Date(order.missing_since).toISOString().slice(0, 10)}. It still counts; see the "Missing from BigCommerce" report.`,
                ],
              ] as const)
            : []),
        ] as const
      ).map(([label, value]) => (
        <tr>
          <th style={cellStyle}>{label}</th>
          <td style={cellStyle}>{value}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const History: FC<{ records: AttributionRecord[] }> = ({ records }) =>
  records.length === 0 ? (
    <p>No attribution changes yet.</p>
  ) : (
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <thead>
        <tr>
          {["When (UTC)", "From", "To", "By", "Note"].map((heading) => (
            <th style={cellStyle}>{heading}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr>
            <td style={cellStyle}>{new Date(record.created_at).toISOString().slice(0, 16).replace("T", " ")}</td>
            <td style={cellStyle}>
              <MemberLink email={record.previous_member_email} />
            </td>
            <td style={cellStyle}>
              <MemberLink email={record.member_email} />
            </td>
            <td style={cellStyle}>{record.admin_email ?? ""}</td>
            <td style={cellStyle}>{record.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const orders = new Hono<AuthEnv & { Bindings: Env }>();

orders.use("*", requireAdmin);
orders.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

orders.get("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  const order = await getAttributableOrder(c.env.DB, orderId);
  if (!order) {
    return c.html(
      <AdminPage title="Order not found">
        <p>No membership order has the id {orderId}.</p>
      </AdminPage>,
      404,
    );
  }
  const path = orderPath(order.order_id);
  const history = await listAttributions(c.env.DB, order.order_id);
  const attributedFrom = c.req.query("attributed_from");
  const proposed = c.req.query("email") === undefined ? null : parseAttribution(order, c.req.query("email"), c.req.query("note"));

  const done = attributedFrom
    ? { previous: attributedFrom, previousFootprint: await emailFootprint(c.env.DB, attributedFrom), currentFootprint: await emailFootprint(c.env.DB, order.member_email) }
    : null;
  const review = proposed && "email" in proposed ? { ...proposed, footprint: await emailFootprint(c.env.DB, proposed.email) } : null;

  return c.html(
    <AdminPage title={`Membership order ${order.order_id}`}>
      {done && (
        <section style="border: 1px solid var(--verde); padding: 0.5rem 1rem; margin-bottom: 1rem">
          <p>
            Attributed to <strong>{order.member_email}</strong> (previously {done.previous}).
            {c.req.query("emailed") === "1" && " Their card is on its way by email."} Their cards now:
          </p>
          <Footprint email={order.member_email} footprint={done.currentFootprint} />
          <Footprint email={done.previous} footprint={done.previousFootprint} />
        </section>
      )}
      {rereadMessage(c.req.query("reread")) && <p class="muted">{rereadMessage(c.req.query("reread"))}</p>}
      <OrderDetails order={order} />
      {order.source === "bigcommerce" && (
        <p>
          <RereadButton orderId={order.order_id} from="order" />
        </p>
      )}

      <h2>Attribute to someone else</h2>
      {review ? (
        <form method="post" action={`${path}/member`}>
          <p>Attribute this order to:</p>
          <Footprint email={review.email} footprint={review.footprint} />
          {review.note && <p>Note: {review.note}</p>}
          <input type="hidden" name="email" value={review.email} />
          <input type="hidden" name="note" value={review.note ?? ""} />
          <p>
            <label>
              <input type="checkbox" name="email_card" checked />
              {" Email them their card"}
            </label>
            {!order.counts && " (nothing will be sent: this order doesn't count as a membership)"}
          </p>
          <button type="submit">Confirm</button> <a href={path}>Cancel</a>
        </form>
      ) : (
        <form method="get" action={path}>
          {proposed && "error" in proposed && <p style="color: var(--danger)">{proposed.error}</p>}
          <label>
            Member email
            <br />
            <input type="email" name="email" required value={c.req.query("email") ?? ""} />
          </label>
          <br />
          <label>
            Note (optional, e.g. "gift from the purchaser")
            <br />
            <input type="text" name="note" maxlength={MAX_NOTE_LENGTH} value={c.req.query("note") ?? ""} style="width: 30rem; max-width: 100%" />
          </label>
          <br />
          <button type="submit">Review</button>
        </form>
      )}

      <h2>History</h2>
      <History records={history} />
    </AdminPage>,
    proposed && "error" in proposed ? 400 : 200,
  );
});

orders.post("/:orderId/member", csrf(), async (c) => {
  const order = await getAttributableOrder(c.env.DB, c.req.param("orderId"));
  if (!order) {
    return c.text("Not Found", 404);
  }
  const form = await c.req.parseBody();
  const input = parseAttribution(order, form.email, form.note);
  if ("error" in input) {
    return c.text(`Bad Request: ${input.error}`, 400);
  }
  const { previousMemberEmail, current } = await attributeOrder(c.env, order, input.email, c.get("session").userId, input.note);
  // Only the new member, only when they have a card, only this once.
  const emailing = form.email_card === "on" && current !== null;
  if (emailing) {
    c.executionCtx.waitUntil(emailMemberCard(c.env, input.email, { kind: "attribution" }));
  }
  const params = new URLSearchParams({ attributed_from: previousMemberEmail });
  if (emailing) params.set("emailed", "1");
  return c.redirect(`${orderPath(order.order_id)}?${params}`, 303);
});

/** The fields a re-read can change, to tell "updated" from "unchanged". */
async function orderSnapshot(db: D1Database, orderId: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT status, expires_on, membership_units, missing_since, sku, first_name, last_name FROM membership_orders WHERE order_id = ?",
    )
    .bind(orderId)
    .first();
  return row === null ? null : JSON.stringify(row);
}

/**
 * Re-reads one order from BigCommerce and applies it as a sync would. Never
 * emails: `readOrderFromStore` stops short of the webhook's card email, and
 * that is the point of calling it rather than `syncBigCommerceOrder`.
 */
orders.post("/:orderId/reread", csrf(), async (c) => {
  const order = await getAttributableOrder(c.env.DB, c.req.param("orderId"));
  if (!order) {
    return c.text("Not Found", 404);
  }
  if (order.source !== "bigcommerce") {
    return c.text("Bad Request: only BigCommerce orders can be re-read from the store", 400);
  }
  const form = await c.req.parseBody();

  let result: RereadResult;
  const before = await orderSnapshot(c.env.DB, order.order_id);
  try {
    const outcome = await readOrderFromStore(c.env, c.env.BIGCOMMERCE_STORE_HASH, order.order_id);
    if (outcome.kind === "missing") result = "missing";
    else if (outcome.kind === "no-membership") result = "no-membership";
    else result = (await orderSnapshot(c.env.DB, order.order_id)) === before ? "unchanged" : "updated";
  } catch (error) {
    console.error("admin order re-read failed", { error: String(error) });
    result = "unreachable";
  }
  recordOutcome("order.reread", { result });

  if (form.from === "member") {
    const params = new URLSearchParams({ q: order.member_email, reread: result, order: order.order_id });
    // The members page's path, spelled out: it imports this module, so importing
    // its constant back would be circular.
    return c.redirect(`/admin/members?${params}`, 303);
  }
  return c.redirect(`${orderPath(order.order_id)}?${new URLSearchParams({ reread: result })}`, 303);
});

export default orders;
