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
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { formatShortDate } from "../lib/dateFormat";
import { isWellFormedEmail } from "../member/email-card";
import { cardNameText, getMemberById, getMemberByEmail, type MemberRecord } from "../member/artifacts";
import { getMemberOrderHistory, type MemberOrder } from "../member/orderHistory";
import {
  MAX_DISPLAY_NAME_LENGTH,
  clearDisplayName,
  getDisplayName,
  normalizeDisplayName,
  setDisplayName,
} from "../member/displayName";
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

const NAME_SET_BY: Record<string, string> = {
  member: "They set that name themselves",
  admin: "An admin set that name for them",
  legacy_postgres: "That name came across from the previous site",
};

const Summary: FC<{
  member: MemberRecord;
  footprint: EmailFootprint;
  orders: MemberOrder[];
  nameSetBy: string | null;
}> = ({ member, footprint, orders, nameSetBy }) => (
  <>
    <h2>{cardNameText(member)}</h2>
    {member.display_name && (
      <p class="muted">
        {(nameSetBy && NAME_SET_BY[nameSetBy]) ?? "That name was set for them"}; their
        orders say {`${member.first_name} ${member.last_name}`.trim() || "nothing"}.
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
    <h3>The name on their card</h3>
    <p>
      Shown instead of the name their orders give. Useful for a gifted membership,
      where the card carries the buyer's name until the recipient orders something
      of their own -- and for anyone who asks for a correction rather than making it
      themselves.
    </p>
    <form method="post" action={MEMBERS_PATH}>
      <input type="hidden" name="email" value={member.email} />
      <label for="display_name">Name to show</label>
      <input
        id="display_name"
        name="display_name"
        type="text"
        value={member.display_name ?? ""}
        maxlength={MAX_DISPLAY_NAME_LENGTH}
        placeholder={`${member.first_name} ${member.last_name}`.trim()}
        autocomplete="off"
      />
      <label for="note">Why (optional, kept for whoever asks later)</label>
      <input id="note" name="note" type="text" maxlength={200} autocomplete="off" />
      <button type="submit">Save</button>
    </form>
    {member.display_name && (
      <form method="post" action={MEMBERS_PATH}>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="clear" />
        <button type="submit">Use the name from their orders instead</button>
      </form>
    )}
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

  const [footprint, orders, override] = member
    ? await Promise.all([
        emailFootprint(c.env.DB, member.email),
        getMemberOrderHistory(c.env, member.email),
        getDisplayName(c.env, member.email),
      ])
    : [null, [], null];

  return c.html(
    <AdminPage title="Find a member">
      <p>
        The card number is on the back of every pass, so it is the one thing a member can
        always read out. An order number goes straight to that order.
      </p>
      <SearchForm q={c.req.query("q") ?? ""} />
      {c.req.query("saved") === "set" && (
        <p style="color: var(--success)">Name saved. Their passes will catch up shortly.</p>
      )}
      {c.req.query("saved") === "cleared" && (
        <p style="color: var(--success)">
          Name removed. Their card is back to the name their orders give.
        </p>
      )}
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {notFound && <p style="color: var(--danger)">{notFound}</p>}
      {member && footprint && (
        <Summary
          member={member}
          footprint={footprint}
          orders={orders}
          nameSetBy={override?.source ?? null}
        />
      )}
    </AdminPage>,
  );
});

/**
 * Setting a name on somebody's behalf. Redirects back to this member rather
 * than rendering, so a refresh does not resubmit and the saved message is on
 * the page the admin was already looking at.
 */
members.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
  const back = (params: Record<string, string>) =>
    c.redirect(`${MEMBERS_PATH}?${new URLSearchParams({ q: email, ...params })}`, 303);

  if (!email) return back({ error: "No member to set a name for." });

  if (form.action === "clear") {
    const existing = await getDisplayName(c.env, email);
    if (!existing) return back({ error: "There was no name to remove." });
    await clearDisplayName(c.env, email);
    return back({ saved: "cleared" });
  }

  const result = normalizeDisplayName(
    typeof form.display_name === "string" ? form.display_name : "",
  );
  if (!result.ok) return back({ error: result.reason });

  const note = typeof form.note === "string" && form.note.trim() !== "" ? form.note.trim() : null;
  // `source = 'admin'` rather than 'member': it records who to point at when
  // somebody asks why their card says what it says.
  await setDisplayName(c.env, email, result.value, "admin", note);
  return back({ saved: "set" });
});

export default members;
