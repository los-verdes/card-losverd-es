/** Shared shell for the admin pages (src/admin/). */

import type { FC, PropsWithChildren } from "hono/jsx";
import { EnvironmentBanner, titlePrefix } from "../environment";
import { FORM_BUSY_SCRIPT } from "../formBusy";
import { SiteFooter } from "../siteFooter";
import { STYLESHEET_PATH } from "../styles";
import { memberNames } from "./memberNames";
import { AdminNav } from "./nav";
import { TABLE_FILTER_SCRIPT } from "./tableFilter";
import { TABLE_SORT_SCRIPT } from "./tableSort";

export const cellStyle = "padding: 0.25rem 0.6rem; text-align: left; border-bottom: 1px solid var(--rule); white-space: nowrap";

/**
 * An address as a link to the members page, which shows its member or, for
 * an address with none, the orders it holds (#320). Admin tables that list
 * members by address link them this way. The path is spelled out because
 * the members page imports the pages that use this.
 *
 * The name on the member's card leads, with the address beneath it
 * (src/admin/memberNames.ts): a name is what an admin scans a table for.
 * `plain` leaves the name off where the row already shows one for the same
 * person, and an address with no member shows alone. `href` points somewhere
 * else on the member's page, as the audit log does.
 *
 * `name` puts another name over the address instead of the card's: an order's
 * own name, in tables of orders, where the address is the one the order was
 * placed under. An empty one leaves the address alone.
 */
export const MemberLink: FC<{ email: string; plain?: boolean; href?: string; name?: string }> = async ({
  email,
  plain,
  href,
  name: given,
}) => {
  const name = given !== undefined ? given.trim() : plain ? undefined : (await memberNames())?.get(email);
  const to = href ?? `/admin/members?q=${encodeURIComponent(email)}`;
  if (!name) return <a href={to}>{email}</a>;
  return (
    <a href={to} class="member-link">
      {name}
      <span class="member-email">{email}</span>
    </a>
  );
};

export const AdminPage: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{`${titlePrefix()}${title} | Los Verdes Admin`}</title>
      <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href={STYLESHEET_PATH} />
    </head>
    <body class="admin">
      <EnvironmentBanner />
      <AdminNav />
      <h1>{title}</h1>
      {children}
      <SiteFooter />
      <script dangerouslySetInnerHTML={{ __html: FORM_BUSY_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: TABLE_SORT_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: TABLE_FILTER_SCRIPT }} />
    </body>
  </html>
);
