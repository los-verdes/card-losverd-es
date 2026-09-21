/**
 * Shared page shell for server-rendered pages (Hono JSX). Still deliberately
 * minimal -- one narrow centred column, and client-side JavaScript only for
 * two small things: the busy state on submitted forms (src/formBusy.ts) and
 * the Web Analytics beacon (./webAnalytics.tsx). Everything works without
 * it. The
 * styling now comes from `/assets/app.css` rather than an inline attribute,
 * so the pages carry the group's colour and display face (#97).
 */

import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { FORM_BUSY_SCRIPT } from "../formBusy";
import { STYLESHEET_PATH } from "../styles";
import { WebAnalyticsBeacon } from "./webAnalytics";

/** Where members are told to write when something's wrong (the legacy app's contact). */
export const SUPPORT_EMAIL = "merchteam@losverdesatx.org";

/**
 * The Membership Committee, for the things that are theirs rather than the
 * Merch Team's: anything that settles a person's standing in the group.
 *
 * Published on the group's own Code of Conduct page, so it is safe to show
 * to somebody who is not signed in -- which matters, because the page most
 * likely to need it is the one refusing a sign-in.
 */
export const MEMBERSHIP_COMMITTEE_EMAIL = "mc@losverdesatx.org";

/**
 * `nav` renders full width, above the column, so something wider than the
 * column can be shown without widening the card page for everyone. Only the
 * admin nav uses it today: an admin's own card is a member page, and the one
 * small link at the foot of it was easy to miss.
 */
export const Page: FC<
  PropsWithChildren<{ title: string; nav?: Child }>
> = ({ title, nav, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} | Los Verdes</title>
      <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href={STYLESHEET_PATH} />
    </head>
    <body class="member">
      {nav}
      <main>{children}</main>
      <script dangerouslySetInnerHTML={{ __html: FORM_BUSY_SCRIPT }} />
      <WebAnalyticsBeacon />
    </body>
  </html>
);
