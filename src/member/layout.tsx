/**
 * Shared page shell for server-rendered pages (Hono JSX). Still deliberately
 * minimal -- one narrow centred column, no client-side JavaScript -- but the
 * styling now comes from `/assets/app.css` rather than an inline attribute,
 * so the pages carry the group's colour and display face (#97).
 */

import type { FC, PropsWithChildren } from "hono/jsx";

/** Where members are told to write when something's wrong (the legacy app's contact). */
export const SUPPORT_EMAIL = "merchteam@losverdesatx.org";

export const Page: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} | Los Verdes</title>
      <link rel="stylesheet" href="/assets/app.css" />
    </head>
    <body class="member">
      {children}
    </body>
  </html>
);
