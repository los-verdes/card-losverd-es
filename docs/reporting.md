# Membership reporting

The legacy app's membership reports lived in Google Data Studio, which read
the legacy Postgres database directly through a read-only SQL user. The
cutover retired that database, and Data Studio cannot connect to D1, so reporting is
rebuilt here as **admin-only pages inside the Worker**
([#53](https://github.com/los-verdes/card-losverd-es/issues/53)). Cloudflare
has no Data Studio equivalent, and an export pipeline to keep Data Studio
alive would be one more thing to maintain.

## The data: `membership_orders`

`members` holds only each member's *current* state. Reports need history
("who was a member on a given date"), so `membership_orders` keeps one row
per membership order, ever. It is a port of the legacy
`annual_membership` table.

* **`created_on` / `expires_on`**: ISO8601 UTC text. `expires_on` is
  `created_on` + 365 days, stored so that "active at instant T" is the
  indexed range query `created_on <= T AND expires_on > T`.
* **`order_email` / `member_email`**: the address typed on the order, and the
  address the membership is currently attributed to. They differ when a
  member has changed address, or when one person buys a membership for
  someone else. Reports group people by `member_email`.
* **`status`**: the store's own order status, verbatim.
* **`first_seen_via`**: `sync` or `legacy_postgres`.

Two writers fill it, and converge on the same rows because both use the
same key -- the store's own order id, for BigCommerce and Squarespace
alike:

1. **The BigCommerce sync** (`src/bigcommerce/orders.ts`) records every
   membership order it processes, from webhooks and scheduled resyncs alike.
   A resync refreshes the store's fields (so a refund lands) but never
   overwrites `member_email`.
2. **The one-time legacy import** (September 2026; its tooling has since been
   removed) carried every legacy order, BigCommerce and Squarespace. It is
   the only surviving record of Squarespace-era orders. For an order the sync
   had already recorded, it only filled in `member_email`, and never for an
   order an admin had attributed.
3. **Admins** attribute an order to someone other than its purchaser on
   `/admin/orders/<order id>` (linked from every order id in the reports).
   Entering an address first shows everywhere it already appears (member
   card, orders, login, Slack) as a typo check; confirming updates
   `member_email`, appends a row to `membership_order_attributions` (who,
   when, from, to, note), and re-derives both people's cards. Attributing it
   back to `order_email` undoes it; the history keeps both. Every order
   attributed to one address can be moved to another at once on
   `/admin/move-orders` (linked from a member page listing more than one
   order), with the same review step and one history row per order.

### What counts as a membership

One rule, over the stores' own statuses (`src/lib/membershipOrders.ts`):

* **BigCommerce orders** count only when paid: `Awaiting Fulfillment`,
  `Awaiting Shipment`, `Completed`, `Partially Shipped`, or `Shipped`, and
  `Partially Refunded` while its membership line item wasn't the part refunded
  (`membership_units_refunded`, from BigCommerce's `quantity_refunded`). An
  `Incomplete`, `Pending` or `Awaiting Payment` order gets no card and no
  report row, and neither does a `Refunded`, `Cancelled`, `Declined` or
  `Disputed` one.
* **Squarespace-era orders** carry the verdict they were given when they were
  imported (`frozen_counts`): they counted unless cancelled, refunded or
  declined, because Squarespace's `PENDING` meant paid. A report on one of
  those years therefore cannot change when the paid list does. The
  provenance document covers Squarespace-era orders.

Membership cards use the same rule as the reports: the `members` sync derives
each card from the member's counted orders (see
[`bigcommerce-ingestion.md`](bigcommerce-ingestion.md) section 2).

## The pages (`/admin/reports`)

All require an admin (see the README for granting that), are served
`Cache-Control: no-store`, and offer a CSV download of every row,
linked above each table. CSV cells that a spreadsheet would evaluate as
formulas are neutralized (`src/lib/csv.ts`), since names and emails are typed
by the public.

The CSV is the way to do anything more involved with a report. The pages
themselves send every row, not a page of them, and any table sorts
by a click on a column heading (`src/admin/tableSort.ts`, a small inline
script; without JavaScript the table stays in the server's order). A box
above each table narrows it to the rows mentioning every word typed, in any
column (`src/admin/tableFilter.ts`). It filters what is on screen only, in
the browser, so the CSV link still downloads the whole report and nothing
typed there leaves the page. The
membership-over-time page draws its charts as lines on the server, as SVG
(`src/admin/lineChart.tsx`), each above its table.

| Page | Shows | Legacy report page it replaces |
| :--- | :--- | :--- |
| `/admin/reports/memberships` | Two tables on one page, for now or the end of any past date (`?as_of=YYYY-MM-DD`, UTC): **Active**, every active membership order, counting distinct members and orders; and **Expired**, each lapsed member's most recent order. Each order shows the name given on it over the address it was placed under, linking to the order, beside the member it counts for. Each downloads on its own (`?format=csv&table=active` or `expired`). `/admin/reports/active` and `/admin/reports/expired`, the two pages this replaced, redirect to its sections. | Active Memberships, Expired Memberships |
| `/admin/reports/over-time` | Membership over time, for any years side by side (the last three by default) or as one line across every year (`?view=timeline`). Two charts, each with its table. **Active members** on each day since the first order: a day counts exactly as the Active memberships report counts it, with a test holding the two together (`src/admin/membersOverTime.ts`); the table has the count on the first of each month, and the download has every day. **Membership orders** per month, as bars grouped by month, one per year (every year in the timeline), so a month can be set against the same month in other years: the table has each month and each year's total, and the download has every month. **Orders by product**: the same orders, one row per membership product (`MEMBERSHIP_PRODUCTS` in `src/bigcommerce/sync.ts`) and one column per year (every year, whichever are compared above), with Squarespace-era orders as one row since their products aren't told apart, and any order without a recorded SKU as another; the download has one row per year and product. Also compares today with this day last year, for both. `/admin/reports/orders?year=Y`, the page this replaced, redirects here with Y and the year before. | Membership Orders |
| `/admin/reports/renewals` | What MiniBC says about members' automatic renewals (#397), matched to members through orders (`src/minibc/renewals.ts`). Six lists, each with a CSV: membership cards that ran out while renewal is still on; renewals due more than a day after the membership card runs out; renewals in the next 30 days; cancelled or paused while the membership card is still current; subscriptions no order matches whose email is a member's address, shown as a hint only (#470); and subscriptions matched to no member, each with what it's for (its SKU, flagged when it isn't a membership product this site counts), its order's admin page (which can read an order not held here in from BigCommerce) and its store customer in BigCommerce. The first three lists and the address hints add "Expiry − renewal (days)": the membership card's last day minus MiniBC's next payment, negative when the card runs out first and positive when the renewal comes first (also `expiry_minus_renewal_days` in their CSVs). Shows when MiniBC was last read. A member's own page has the same as a "Renewal" row, including any subscription only their address points to, labelled as such. | MiniBC Subscriptions |
| `/admin/reports/consolidations` | Choices that make a card differ from its orders: orders whose membership is attributed to another address (with who changed it, when, and why), card names set by hand, and corrected "member since" dates. Then, in a table of its own, the card names the old site carried over, which mostly nobody chose (the old site named a card after its first order or the member's Google or Apple profile). Each order links to its admin page, each address to its member. | Membership Consolidations |
| `/admin/reports/slack` | Four tables: current members in Slack, current members not in Slack, lapsed members in Slack, and Slack users with no membership orders. Each member row has when the membership started (its latest order's date) and when it expires. Where MiniBC is read, the lapsed members are split by their automatic renewal: still on (so a payment failed or is still to be tried), cancelled or paused, or never set up (`src/admin/slackRenewals.ts`), with the same "Expiry − renewal (days)" on the still-on table; `?table=lapsed-in-slack` still downloads all of them. Current snapshot only; each table downloads separately (`?table=...&format=csv`). | Slack User Stuff |
| `/admin/reports/missing` | Orders BigCommerce no longer returns, oldest sighting first. They still count towards membership; this is the list to decide about. | None -- the legacy app never noticed |
| `/admin/reports/extra-memberships` | Orders carrying more than one membership, most first, while they still count and have not expired. Only one was recorded, so somebody paid for a card that does not exist. | None -- the legacy app never noticed |

The memberships page also takes a `channel`, which narrows the query
and so the CSV too. Narrowing by name or address is the table's filter box,
or a spreadsheet's over the CSV. SQL lives in
`src/admin/reportQueries.ts`, shared by the HTML and CSV forms of each report
so they cannot disagree.

### Consolidations

The first table is every order whose `member_email` differs from its
`order_email`, newest change first; an order the legacy import re-pointed
shows "legacy import" rather than an admin and a date.

The next two list the overrides a member or an admin set, newest first: card
names (`member_display_names`) and corrected "member since" dates
(`member_since_overrides`). Each sits beside what the orders alone would
give -- the name from the latest counted order, the date of the earliest --
with that order linked, and says who set it. The last lists the card names
the legacy import carried over from the previous site, which mostly nobody
chose and which members and admins can change. A
"Compared" column reads "same" where an override has come to match its
orders and so changes nothing (a candidate to clear), "differs" otherwise,
and "no card" for an address with no card here.

The legacy report also grouped billing names found under more than one
address. Nothing was ever done with that list, so it is no longer shown.

### Missing from BigCommerce

Orders the store has stopped returning, with when each was first missed
(los-verdes/card-losverd-es#105). **Nothing on this page has been revoked
from anyone**: a flagged order counts towards its member's membership exactly
as it did before, and their card is untouched. The flag exists because
deciding to end somebody's membership is a judgement, and a 404 from an API
is not a good enough reason to make it automatically -- a BigCommerce incident
would otherwise become mass membership loss.

An order is flagged when the store answers that it no longer exists: when a
webhook prompts a sync, when an admin re-reads it from BigCommerce, or when
the weekly full resync asks about an order it
holds that counts towards a membership and that the store's order list did
not return. The flag clears itself if a later sync finds the
order again, so a 404 during an outage does not leave a mark to tidy up by
hand.

Two things it does not cover. It catches **deletion**, not **archival**: an
archived order is still returned, by the order list and by its own id, marked
as deleted, which the sync does not read, so it is applied again and nothing
notices.
And there is deliberately no button here to stop a flagged order counting --
that is a revocation of a membership, recorded on `/admin/revocations` after a
Membership Committee decision
([#31](https://github.com/los-verdes/card-losverd-es/issues/31)).

### Slack cross-reference

Members are matched to `slack_users` on lowercased `member_email`, so a member
who joined Slack under another address shows as not in Slack. "Current" and
"lapsed" follow the active and expired pages: whether the member's
latest-expiring order is still active. Only live human accounts count as
being in Slack: deactivated accounts (`deleted = 1`), bots, app and workflow
users, and accounts without an email (such as Slackbot) are ignored. Guests
and pending invites count. The page shows when the Slack sync last ran, since
until it has run (`SLACK_BOT_TOKEN` set) every member shows as not in Slack.

### Not built yet

| Legacy page | Plan |
| :--- | :--- |
| Membership Cards (cards generated, unique Apple devices, plus web analytics charts) | Low priority. Counts can come from `registrations`/`devices`. The analytics charts are covered by Cloudflare Web Analytics on the member pages (see the README, "What we record about visits"), so they are not rebuilt here. |

## Slack members sync

`run_slack_members_etl` (`src/slack/membersEtl.ts`) pages Slack's
`users.list` and upserts into `slack_users`, keeping the legacy table's
columns so report queries carry over. It exists for reporting and for
subgroups: after the user list it copies each subgroup's Slack channel into
`slack_channel_members` (`src/slack/channelMembers.ts`), which decides who may
use that subgroup's card theme. The legacy app never had any inbound Slack
integration. Deactivated accounts stay
listed by Slack with `deleted = 1`, so there is no pruning step.

Unlike the legacy job, it does not create a login `users` row per Slack
member; join on email instead. It skips itself, with a warning, until
`SLACK_BOT_TOKEN` is set. Both environments run it every six hours, each
against its own Slack app, so the real membership roll stays out of staging.

## Who is an admin

An admin is a user with `users.is_admin` set. Access is granted and removed on
`/admin/admins`, or with `just admin-grant <env> <address...>`; an address does
not need to have signed in first, and the page will not let an admin remove
themselves. Both leave a line in the audit log.

The list is kept short by hand today. The intended list is the Los Verdes
board (the "Starting XI"), the Merch Team, who administer the storefront and
answer `merchteam@losverdesatx.org`, and the Membership Committee. Those names are published on the
group's website, so the list may be derivable from there rather than
maintained by hand; undecided.
