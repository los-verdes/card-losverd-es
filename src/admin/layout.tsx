/** Shared shell for the admin pages (src/admin/). */

import type { FC, PropsWithChildren } from "hono/jsx";
import { FORM_BUSY_SCRIPT } from "../formBusy";
import { STYLESHEET_PATH } from "../styles";
import { AdminNav } from "./nav";

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
      <AdminNav />
      <h1>{title}</h1>
      {children}
      <script dangerouslySetInnerHTML={{ __html: FORM_BUSY_SCRIPT }} />
    </body>
  </html>
);
