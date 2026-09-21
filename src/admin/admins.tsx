/**
 * Who can use the admin pages, and changing that (src/admin/adminAccess.ts).
 *
 * Built for setting up a group at once -- the Merch Team, the Membership
 * Committee -- so a grant takes a pasted list and works for people who have
 * never signed in. Each change is in the audit log with who made it.
 *
 * An admin cannot revoke themselves here. `just admin-revoke` can, and so can
 * another admin; the page just will not let the last one lock everybody out
 * in a click.
 */

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { FC } from "hono/jsx";
import type { Env } from "../index";
import { isWellFormedEmail } from "../member/email-card";
import { requireAdmin, type AuthEnv } from "../middleware/auth";
import {
  grantAdmin,
  listAdmins,
  parseAddressList,
  revokeAdmin,
  type Admin,
  type GrantOutcome,
} from "./adminAccess";
import { AdminPage, cellStyle } from "./layout";

export const ADMINS_PATH = "/admin/admins";

const admins = new Hono<AuthEnv & { Bindings: Env }>();
admins.use("*", requireAdmin);
admins.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

type GrantResult = { email: string; outcome: GrantOutcome | "not-an-address" };

const OUTCOME_TEXT: Record<GrantResult["outcome"], string> = {
  granted: "Now an admin.",
  "granted-before-sign-in": "Now an admin; it applies when they first sign in with this address.",
  already: "Already an admin.",
  "not-an-address": "Not an email address; nothing done.",
};

const AdminsPage: FC<{
  list: Admin[];
  selfId: number;
  results?: GrantResult[];
  notice?: string;
  error?: string;
}> = ({ list, selfId, results, notice, error }) => (
  <AdminPage title="Admins">
    <p>
      Everyone here can see and change members&#39; records. A change takes effect on that person&#39;s next page
      load, and every one is in the <a href="/admin/audit">history</a>.
    </p>
    {notice && <p style="color: var(--success)">{notice}</p>}
    {error && <p style="color: var(--danger)">{error}</p>}
    {results && (
      <ul>
        {results.map((result) => (
          <li>
            {result.email}: {OUTCOME_TEXT[result.outcome]}
          </li>
        ))}
      </ul>
    )}
    <div style="overflow-x: auto">
      <table style="border-collapse: collapse; font-size: 0.9rem">
        <thead>
          <tr>
            {["Address", "Name", "Signed in yet", ""].map((heading) => (
              <th style={cellStyle}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((admin) => (
            <tr>
              <td style={cellStyle}>{admin.email}</td>
              <td style={cellStyle}>{admin.full_name ?? ""}</td>
              <td style={cellStyle}>{admin.signed_in ? "Yes" : "Not yet"}</td>
              <td style={cellStyle}>
                {admin.id === selfId ? (
                  "You"
                ) : (
                  <form method="post" action={ADMINS_PATH}>
                    <input type="hidden" name="action" value="revoke" />
                    <input type="hidden" name="email" value={admin.email} />
                    <button type="submit">Remove admin</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <h2>Add admins</h2>
    <p>
      One address or several -- separated by commas, spaces or new lines. Use the address each person signs in with,
      which for someone using Apple&#39;s Hide My Email is their relay address. They do not need to have signed in
      first.
    </p>
    <form method="post" action={ADMINS_PATH}>
      <input type="hidden" name="action" value="grant" />
      <p>
        <textarea name="addresses" rows={4} cols={50} required></textarea>
      </p>
      <p>
        <button type="submit">Make admin</button>
      </p>
    </form>
  </AdminPage>
);

admins.get("/", async (c) => {
  const notice = c.req.query("saved") === "revoked" ? "Admin access removed." : undefined;
  return c.html(<AdminsPage list={await listAdmins(c.env)} selfId={c.get("session").userId} notice={notice} />);
});

admins.post("/", csrf(), async (c) => {
  const form = await c.req.parseBody();
  const selfId = c.get("session").userId;

  if (form.action === "revoke") {
    const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
    const self = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(selfId).first<{ email: string }>();
    if (!email || email === self?.email) {
      return c.html(
        <AdminsPage
          list={await listAdmins(c.env)}
          selfId={selfId}
          error="You can't remove your own admin access here. Ask another admin, or use just admin-revoke."
        />,
        400,
      );
    }
    if (!(await revokeAdmin(c.env, email, selfId))) {
      return c.html(
        <AdminsPage list={await listAdmins(c.env)} selfId={selfId} error="That person is not an admin." />,
        400,
      );
    }
    // No address in the URL: it would end up in request logs.
    return c.redirect(`${ADMINS_PATH}?saved=revoked`, 303);
  }

  const addresses = parseAddressList(typeof form.addresses === "string" ? form.addresses : "");
  if (addresses.length === 0) {
    return c.html(
      <AdminsPage list={await listAdmins(c.env)} selfId={selfId} error="Enter at least one address." />,
      400,
    );
  }
  // Rendered here rather than redirected, so each address's result can be
  // shown without putting the addresses in a URL. Granting twice is harmless,
  // so a reload that re-submits changes nothing.
  const results: GrantResult[] = [];
  for (const email of addresses) {
    results.push({
      email,
      outcome: isWellFormedEmail(email) ? await grantAdmin(c.env, email, selfId) : "not-an-address",
    });
  }
  return c.html(<AdminsPage list={await listAdmins(c.env)} selfId={selfId} results={results} />);
});

export default admins;
