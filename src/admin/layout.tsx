/** Shared shell for the admin pages (src/admin/). */

import type { FC, PropsWithChildren } from "hono/jsx";
import { STYLESHEET_PATH } from "../styles";

export const cellStyle = "padding: 0.25rem 0.6rem; text-align: left; border-bottom: 1px solid var(--rule); white-space: nowrap";

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
      <nav class="admin-nav">
        <span class="nav-group">
          <span class="nav-label">Reports</span>
          <a href="/admin/reports">All</a>
          <a href="/admin/reports/active">Active</a>
          <a href="/admin/reports/expired">Expired</a>
          <a href="/admin/reports/orders">By month</a>
          <a href="/admin/reports/slack">Slack</a>
          <a href="/admin/reports/consolidations">Consolidations</a>
        </span>
        <span class="nav-group">
          <span class="nav-label">Needs a look</span>
          <a href="/admin/reports/missing">Missing orders</a>
          <a href="/admin/reports/extra-memberships">Extra memberships</a>
        </span>
        <span class="nav-group">
          <span class="nav-label">Members</span>
          <a href="/admin/members">Find</a>
          <a href="/admin/member-since">Member since</a>
          <a href="/admin/revocations">Withdrawn</a>
        </span>
        <span class="nav-group">
          <span class="nav-label">This environment</span>
          <a href="/admin/preflight">Readiness</a>
          <a href="/">My card</a>
        </span>
      </nav>
      <h1>{title}</h1>
      {children}
    </body>
  </html>
);
