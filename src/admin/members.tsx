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
import {
  MAX_REVOCATION_NOTE_LENGTH,
  restoreCard,
  revokeCard,
} from "../member/revocation";
import { MAX_EXPULSION_NOTE_LENGTH, expelPerson, isExpelled, readmitPerson } from "../member/expulsion";
import { emailFootprint, type EmailFootprint } from "./attribution";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import { AdminPage, cellStyle } from "./layout";
import { RereadButton, orderPath, rereadMessage } from "./orders";

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
 * shapes (`1001` from the store, a 24-character hex id from the
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
  nameSetByEmail: string | null;
  expelled: boolean;
}> = ({ member, footprint, orders, nameSetBy, nameSetByEmail, expelled }) => (
  <>
    <h2>{cardNameText(member)}</h2>
    {member.display_name && (
      <p class="muted">
        {(nameSetBy && NAME_SET_BY[nameSetBy]) ?? "That name was set for them"}
        {nameSetByEmail ? ` (${nameSetByEmail})` : ""}; their orders say{" "}
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
    <h3>Membership standing</h3>
    <p class="muted">
      Rarely needed, and the Membership Committee's decision. Revoking stops this card; expelling also
      stops the person signing in. Either can be lifted, and their orders are untouched.
    </p>
    {member.revoked ? (
      <form method="post" action={MEMBERS_PATH}>
        <p class="danger">
          <strong>This membership has been revoked.</strong>
        </p>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="restore" />
        <button type="submit">Restore this membership</button>
      </form>
    ) : (
      <form method="post" action={MEMBERS_PATH}>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="revoke" />
        <label for="revocation_note">Reason for revoking (optional)</label>
        <input id="revocation_note" name="revocation_note" type="text" maxlength={MAX_REVOCATION_NOTE_LENGTH} autocomplete="off" />
        <button type="submit">Revoke this membership</button>
      </form>
    )}
    {expelled ? (
      <form method="post" action={MEMBERS_PATH}>
        <p class="danger">
          <strong>This person has been expelled from Los Verdes.</strong>
        </p>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="readmit" />
        <button type="submit">Lift this expulsion</button>
      </form>
    ) : (
      <form method="post" action={MEMBERS_PATH}>
        <input type="hidden" name="email" value={member.email} />
        <input type="hidden" name="action" value="expel" />
        <label for="expulsion_note">Reason for expelling (optional)</label>
        <input id="expulsion_note" name="expulsion_note" type="text" maxlength={MAX_EXPULSION_NOTE_LENGTH} autocomplete="off" />
        <button type="submit">Expel this person from the group</button>
      </form>
    )}
    <p class="muted">
      <a href={`/admin/audit?email=${encodeURIComponent(member.email)}`}>
        Everything that has been done to this membership
      </a>
    </p>
    <h3>Their orders</h3>
    {orders.length === 0 ? (
      <p>No orders are attributed to this address.</p>
    ) : (
      <OrdersTable orders={orders} />
    )}
  </>
);

const OrdersTable: FC<{ orders: MemberOrder[] }> = ({ orders }) => (
  <table style="border-collapse: collapse; font-size: 0.9rem">
    <thead>
      <tr>
        {["Order", "Product", "Status", "Placed", "Counts", ""].map((h) => (
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
          <td style={cellStyle}>
            {order.source === "bigcommerce" && <RereadButton orderId={order.order_id} from="member" />}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** An order placed with an address and since pointed at somebody else. */
interface MovedOrder {
  order_id: string;
  member_email: string;
}

async function ordersMovedAway(db: D1Database, email: string): Promise<MovedOrder[]> {
  const { results } = await db
    .prepare(
      `SELECT order_id, member_email FROM membership_orders
       WHERE order_email = ?1 AND member_email != ?1
       ORDER BY created_on DESC, order_id DESC`,
    )
    .bind(email)
    .all<MovedOrder>();
  return results;
}

/**
 * An address that holds orders and no membership
 * (los-verdes/card-losverd-es#241). "No membership is held under that
 * address" is true of it and tells whoever is answering the member nothing
 * they can act on, and it is exactly the state somebody writes in about:
 * every order refunded, an order pointed at somebody else, or -- before an
 * environment's first full resync -- orders that count whose membership has
 * simply not been built yet.
 */
const OrdersWithoutMember: FC<{
  email: string;
  footprint: EmailFootprint;
  orders: MemberOrder[];
  moved: MovedOrder[];
}> = ({ email, footprint, orders, moved }) => (
  <>
    <h2>{email}</h2>
    <p>
      <strong>No membership is held under this address</strong>, but it is not unknown.
      Orders attributed to it: {footprint.memberOrders.total}. Counting towards a
      membership: {footprint.memberOrders.counted}.
    </p>
    {footprint.memberOrders.counted > 0 ? (
      <p>
        An order that counts and no membership means the membership has not been built
        yet. That happens for orders loaded by the one-time import until the order sync
        next reads this person's orders, and it puts itself right when it does.
      </p>
    ) : (
      footprint.memberOrders.total > 0 && (
        <p>
          None of them counts, which is why there is no card. The status beside each says
          why: only a paid order confers a membership, and a refunded or cancelled one
          stops conferring it.
        </p>
      )
    )}
    {orders.length > 0 && <OrdersTable orders={orders} />}
    {moved.length > 0 && (
      <>
        <h3>Placed with this address, and since pointed at somebody else</h3>
        <p>
          These feed another person's card now -- a gift, or an address they no longer
          use. The order page says who moved it and when.
        </p>
        <ul>
          {moved.map((order) => (
            <li>
              <a href={orderPath(order.order_id)}>{order.order_id}</a>, now attributed to{" "}
              <a href={`${MEMBERS_PATH}?q=${encodeURIComponent(order.member_email)}`}>
                {order.member_email}
              </a>
            </li>
          ))}
        </ul>
      </>
    )}
    <p class="muted">
      Signed in before: {footprint.login ? "yes" : "no"}. Slack:{" "}
      {footprint.slack ? (footprint.slack.deleted ? "account deactivated" : "yes") : "no match"}.
    </p>
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
  } else if (lookup.kind === "card") {
    member = await getMemberById(c.env, lookup.value);
    if (!member) notFound = "No membership carries that card number.";
  }

  const [footprint, orders, override, expelled] = member
    ? await Promise.all([
        emailFootprint(c.env.DB, member.email),
        getMemberOrderHistory(c.env, member.email),
        getDisplayName(c.env, member.email),
        isExpelled(c.env, member.email),
      ])
    : [null, [], null, false];

  // An address can hold orders and no membership, and that is a real answer
  // rather than a dead end (#241). Only when there is nothing at all does the
  // page fall back to saying so.
  let orphan: { email: string; footprint: EmailFootprint; orders: MemberOrder[]; moved: MovedOrder[] } | null = null;
  if (lookup.kind === "email" && !member) {
    if (isWellFormedEmail(lookup.value)) {
      const [orphanFootprint, orphanOrders, moved] = await Promise.all([
        emailFootprint(c.env.DB, lookup.value),
        getMemberOrderHistory(c.env, lookup.value),
        ordersMovedAway(c.env.DB, lookup.value),
      ]);
      if (orphanOrders.length > 0 || moved.length > 0) {
        orphan = { email: lookup.value, footprint: orphanFootprint, orders: orphanOrders, moved };
      }
    }
    if (!orphan) notFound = "No membership is held under that address, and no orders either.";
  }

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
      {c.req.query("saved") === "revoked" && (
        <p style="color: var(--success)">Membership revoked.</p>
      )}
      {c.req.query("saved") === "expelled" && (
        <p style="color: var(--success)">Expelled from the group.</p>
      )}
      {c.req.query("saved") === "readmitted" && (
        <p style="color: var(--success)">Expulsion lifted.</p>
      )}
      {c.req.query("saved") === "restored" && (
        <p style="color: var(--success)">
          Membership restored, to whatever their orders say.
        </p>
      )}
      {c.req.query("saved") === "cleared" && (
        <p style="color: var(--success)">
          Name removed. Their card is back to the name their orders give.
        </p>
      )}
      {rereadMessage(c.req.query("reread")) && (
        <p class="muted">
          Order {c.req.query("order")}: {rereadMessage(c.req.query("reread"))}
        </p>
      )}
      {c.req.query("error") && <p style="color: var(--danger)">{c.req.query("error")}</p>}
      {notFound && <p style="color: var(--danger)">{notFound}</p>}
      {orphan && <OrdersWithoutMember {...orphan} />}
      {member && footprint && (
        <Summary
          member={member}
          footprint={footprint}
          orders={orders}
          nameSetBy={override?.source ?? null}
          nameSetByEmail={override?.set_by_email ?? null}
          expelled={expelled}
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

  if (form.action === "expel" || form.action === "readmit") {
    if (form.action === "readmit") {
      return (await readmitPerson(c.env, email, c.get("session").userId))
        ? back({ saved: "readmitted" })
        : back({ error: "That person has not been expelled." });
    }
    const note =
      typeof form.expulsion_note === "string" && form.expulsion_note.trim() !== ""
        ? form.expulsion_note.trim()
        : null;
    return (await expelPerson(c.env, email, note, c.get("session").userId))
      ? back({ saved: "expelled" })
      : back({ error: "That person has already been expelled." });
  }

  if (form.action === "revoke" || form.action === "restore") {
    const member = await getMemberByEmail(c.env, email);
    if (!member) return back({ error: "No membership is held under that address." });

    if (form.action === "restore") {
      return (await restoreCard(c.env, member.member_id, c.get("session").userId))
        ? back({ saved: "restored" })
        : back({ error: "That membership has not been revoked." });
    }

    const note =
      typeof form.revocation_note === "string" && form.revocation_note.trim() !== ""
        ? form.revocation_note.trim()
        : null;
    return (await revokeCard(c.env, member.member_id, note, c.get("session").userId))
      ? back({ saved: "revoked" })
      : back({ error: "That membership has already been revoked." });
  }

  if (form.action === "clear") {
    const existing = await getDisplayName(c.env, email);
    if (!existing) return back({ error: "There was no name to remove." });
    await clearDisplayName(c.env, email, c.get("session").userId);
    return back({ saved: "cleared" });
  }

  const result = normalizeDisplayName(
    typeof form.display_name === "string" ? form.display_name : "",
  );
  if (!result.ok) return back({ error: result.reason });

  const note = typeof form.note === "string" && form.note.trim() !== "" ? form.note.trim() : null;
  // `source = 'admin'` rather than 'member': it records who to point at when
  // somebody asks why their card says what it says.
  await setDisplayName(c.env, email, result.value, "admin", note, c.get("session").userId);
  return back({ saved: "set" });
});

export default members;
