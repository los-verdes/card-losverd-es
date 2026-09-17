/** Shared shell for the admin pages (src/admin/). */

import type { FC, PropsWithChildren } from "hono/jsx";

export const cellStyle = "padding: 0.25rem 0.6rem; text-align: left; border-bottom: 1px solid #ddd; white-space: nowrap";

export const AdminPage: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} | Los Verdes Admin</title>
    </head>
    <body style="font-family: system-ui, sans-serif; margin: 1.5rem auto; max-width: 72rem; padding: 0 1rem">
      <nav style="margin-bottom: 1rem">
        <a href="/admin/reports">Reports</a>
        {" · "}
        <a href="/admin/reports/active">Active memberships</a>
        {" · "}
        <a href="/admin/reports/expired">Expired memberships</a>
        {" · "}
        <a href="/admin/reports/orders">Orders by month</a>
        {" · "}
        <a href="/admin/reports/slack">Slack cross-reference</a>
        {" · "}
        <a href="/">My card</a>
      </nav>
      <h1>{title}</h1>
      {children}
    </body>
  </html>
);
