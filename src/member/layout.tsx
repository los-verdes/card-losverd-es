/**
 * Shared page shell for server-rendered pages (Hono JSX). Deliberately
 * minimal: a centered, single-column layout with system fonts and no
 * external CSS/JS, so every page renders fast and works on a phone at a
 * door.
 */

import type { FC, PropsWithChildren } from "hono/jsx";

export const Page: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} | Los Verdes</title>
    </head>
    <body style="font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 28rem; padding: 0 1rem; text-align: center">
      {children}
    </body>
  </html>
);
