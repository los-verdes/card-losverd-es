/**
 * Finding a member from whatever they happened to quote (#190).
 *
 * Every pass this system issues prints a **Card #** on its back -- the
 * member's `member_id` -- and until this existed nothing could look one up.
 * Every admin lookup was keyed on email, which is the one thing a member
 * writing in often does not know: which address their membership is under is
 * frequently the actual problem they are writing about. They can always read
 * the back of their own pass.
 *
 * So this accepts any of the three identifiers a person might have to hand --
 * a card number, an email address, or an order number -- rather than making
 * the Merch Team work out which door to use.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";
import { isWellFormedEmail } from "../member/email-card";
import { cardNameText, getMemberById, getMemberByEmail, type MemberRecord } from "../member/artifacts";
import { getMemberOrderHistory, type MemberOrder } from "../member/orderHistory";
import { emailFootprint, type EmailFootprint } from "./attribution";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";
import { orderPath } from "./orders";

const members = new Hono<AuthEnv & { Bindings: Env }>();
members.use("*", requireAdmin);
// `no-store`, like every other admin page: this one shows a member's name,
// address, card number and order history in one place.
members.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

export const MEMBERS_PATH = "/admin/members";

/** A card number as printed on the back of a pass. */
const CARD_NUMBER = /^LV-[0-9a-f-]{8,}$/i;

export type Lookup =
  | { kind: "empty" }
  | { kind: "email"; value: string }
  | { kind: "card"; value: string }
  | { kind: "order"; value: string };

/**
 * What the admin typed, by shape.
 *
 * Deliberately permissive about order numbers: anything that is neither an
 * email nor a card number is tried as one, because order ids come in several
 * shapes (`1001_bc` from the store, a 24-character hex id from the
 * Squarespace era) and guessing wrong costs a "not found" rather than
 * anything worse.
 */
export function classify(raw: string): Lookup {
  const value = raw.trim();
  if (value === "") return { kind: "empty" };
  if (value.includes("@")) return { kind: "email", value: value.toLowerCase() };
  if (CARD_NUMBER.test(value)) return { kind: "card", value };
  return { kind: "order", value };
}

const SearchForm: FC<{ q: string }> = ({ q }) => (
  <form method="get" action={MEMBERS_PATH}>
    <label for="q">Card number, email address, or order number</label>
    <input id="q" name="q" type="text" value={q} autocomplete="off" placeholder="LV-..." />
    <button type="submit">Find</button>
  </form>
);

const Summary: FC<{ member: MemberRecord; footprint: EmailFootprint; orders: MemberOrder[] }> = ({
  member,
  footprint,
  orders,
}) => (
  <>
    <h2>{cardNameText(member)}</h2>
    {member.display_name && (
      <p class="muted">
        They chose that name themselves; their orders say{" "}
        {`${member.first_name} ${member.last_name}`.trim() || "nothing"}.
      </p>
    )}
    <table style="border-collapse: collapse; font-size: 0.9rem">
      <tbody>
        <tr>
          <th style={cellStyle}>Card #</th>
          <td style={cellStyle}>{member.member_id}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Email</th>
          <td style={cellStyle}>{member.email}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Tier</th>
          <td style={cellStyle}>{member.membership_tier}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Good through</th>
          <td style={cellStyle}>
            {member.expiration_date ? formatShortDate(member.expiration_date) : "no counted orders"}
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Member since</th>
          <td style={cellStyle}>{member.member_since ?? "not shown"}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Orders</th>
          <td style={cellStyle}>
            {footprint.memberOrders.counted} of {footprint.memberOrders.total} count
          </td>
        </tr>
        <tr>
          <th style={cellStyle}>Signed in before</th>
          <td style={cellStyle}>{footprint.login ? "yes" : "no"}</td>
        </tr>
        <tr>
          <th style={cellStyle}>Slack</th>
          <td style={cellStyle}>
            {footprint.slack ? (footprint.slack.deleted ? "account deactivated" : "yes") : "no match"}
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      <a href={`/admin/member-since?email=${encodeURIComponent(member.email)}`}>
        Correct their &quot;member since&quot; date
      </a>
    </p>
    <h3>Their orders</h3>
    {orders.length === 0 ? (
      <p>No orders are attributed to this address.</p>
    ) : (
      <table style="border-collapse: collapse; font-size: 0.9rem">
        <thead>
          <tr>
            {["Order", "Product", "Status", "Placed", "Counts"].map((h) => (
              <th style={cellStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr>
              <td style={cellStyle}>
                <a href={orderPath(order.order_id)}>{order.order_id}</a>
              </td>
              <td style={cellStyle}>{order.product_name ?? ""}</td>
              <td style={cellStyle}>{order.status ?? ""}</td>
              <td style={cellStyle}>{order.created_on.slice(0, 10)}</td>
              <td style={cellStyle}>{order.counts ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
);

members.get("/", async (c) => {
  const lookup = classify(c.req.query("q") ?? "");

  // An order number identifies a purchase rather than a person, and there is
  // already a page for one, so this hands over rather than reimplementing it.
  if (lookup.kind === "order") {
    return c.redirect(orderPath(lookup.value), 303);
  }

  let member: MemberRecord | null = null;
  let notFound: string | null = null;
  if (lookup.kind === "email") {
    member = isWellFormedEmail(lookup.value)
      ? await getMemberByEmail(c.env, lookup.value)
      : null;
    if (!member) notFound = "No membership is held under that address.";
  } else if (lookup.kind === "card") {
    member = await getMemberById(c.env, lookup.value);
    if (!member) notFound = "No membership carries that card number.";
  }

  const [footprint, orders] = member
    ? await Promise.all([
        emailFootprint(c.env.DB, member.email),
        getMemberOrderHistory(c.env, member.email),
      ])
    : [null, []];

  return c.html(
    <AdminPage title="Find a member">
      <p>
        The card number is on the back of every pass, so it is the one thing a member can
        always read out. An order number goes straight to that order.
      </p>
      <SearchForm q={c.req.query("q") ?? ""} />
      {notFound && <p style="color: var(--danger)">{notFound}</p>}
      {member && footprint && <Summary member={member} footprint={footprint} orders={orders} />}
    </AdminPage>,
  );
});

export default members;
