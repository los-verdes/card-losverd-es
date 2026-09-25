/** Shared shell for the admin pages (src/admin/). */

import type { FC, PropsWithChildren } from "hono/jsx";
import { FORM_BUSY_SCRIPT } from "../formBusy";
import { SiteFooter } from "../siteFooter";
import { STYLESHEET_PATH } from "../styles";
import { AdminNav } from "./nav";
import { TABLE_SORT_SCRIPT } from "./tableSort";

export const cellStyle = "padding: 0.25rem 0.6rem; text-align: left; border-bottom: 1px solid var(--rule); white-space: nowrap";

/**
 * An address as a link to the members page, which shows its member or, for
 * an address with none, the orders it holds (#320). Admin tables that list
 * members by address link them this way. The path is spelled out because
 * the members page imports the pages that use this.
 */
export const MemberLink: FC<{ email: string }> = ({ email }) => (
  <a href={`/admin/members?q=${encodeURIComponent(email)}`}>{email}</a>
);

export const AdminPage: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} | Los Verdes Admin</title>
      <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href={STYLESHEET_PATH} />
    </head>
    <body class="admin">
      <AdminNav />
      <h1>{title}</h1>
      {children}
      <SiteFooter />
      <script dangerouslySetInnerHTML={{ __html: FORM_BUSY_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: TABLE_SORT_SCRIPT }} />
    </body>
  </html>
);
