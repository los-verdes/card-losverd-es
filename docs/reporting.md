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
  `created_on` + 365 days, stored so that "in force at instant T" is the
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
2. **The one-time legacy export** (`scripts/legacy-export/`) carries every
   legacy order, BigCommerce and Squarespace. It is the only surviving record
   of Squarespace-era orders, so it must run before the legacy database is
   decommissioned. For an order the sync already recorded, it only fills in
   `member_email`, and never for an order an admin has attributed.
3. **Admins** attribute an order to someone other than its purchaser on
   `/admin/orders/<order id>` (linked from every order id in the reports).
   Entering an address first shows everywhere it already appears (member
   card, orders, login, Slack) as a typo check; confirming updates
   `member_email`, appends a row to `membership_order_attributions` (who,
   when, from, to, note), and re-derives both people's cards. Attributing it
   back to `order_email` undoes it; the history keeps both.

### What counts as a membership

The rule is per store, because the two don't mean the same things by their
statuses (`src/lib/membershipOrders.ts`, decided 2026-09-17):

* **BigCommerce orders** count only when paid: `Awaiting Fulfillment`,
  `Awaiting Shipment`, `Completed`, `Partially Shipped`, or `Shipped`. An `Incomplete`,
  `Pending` or `Awaiting Payment` order gets no card and no report row, and
  neither does a `Refunded`, `Cancelled`, `Declined`, `Disputed` or
  `Partially Refunded` one.
* **Squarespace-era orders** are closed history with their own vocabulary
  (`FULFILLED`, `PENDING`, `CANCELED`), where `PENDING` means paid but not
  yet shipped. They keep the legacy app's rule: everything counts except a
  cancelled order. Applying BigCommerce's list to them would silently drop
  real historical members.

Membership cards use the same rule as the reports: the `members` sync derives
each card from the member's counted orders (see
[`bigcommerce-ingestion.md`](bigcommerce-ingestion.md) section 2).

## The pages (`/admin/reports`)

All require an admin (see the README for granting that), are served
`Cache-Control: no-store`, and offer a CSV download of every matching row.
CSV cells that a spreadsheet would evaluate as formulas are neutralized
(`src/lib/csv.ts`), since names and emails are typed by the public.

| Page | Shows | Legacy report page it replaces |
| :--- | :--- | :--- |
| `/admin/reports/active` | Orders in force now, or at the end of any past date (`?as_of=YYYY-MM-DD`, UTC). Counts distinct members and orders. | Active Memberships |
| `/admin/reports/expired` | Each lapsed member's most recent order, as of now or a past date. | Expired Memberships |
| `/admin/reports/orders` | Orders per month for a year against the year before. | Membership Orders |
| `/admin/reports/consolidations` | Two tables: orders whose membership is attributed to another address (with who changed it, when, and why), and billing names appearing under several addresses. Each order links to its admin page. | Membership Consolidations |
| `/admin/reports/slack` | Four tables: current members in Slack, current members not in Slack, lapsed members in Slack, and Slack users with no membership orders. Current snapshot only; each table downloads separately (`?table=...&format=csv`). | Slack User Stuff |
| `/admin/reports/missing` | Orders BigCommerce no longer returns, oldest sighting first. They still count towards membership; this is the list to decide about. | None -- the legacy app never noticed |
| `/admin/reports/extra-memberships` | Orders carrying more than one membership, most first. Only one was recorded, so somebody paid for a card that does not exist. | None -- the legacy app never noticed |

Common filters on the active and expired pages: `q` (matches either email
or the billing name) and `channel`. SQL lives in
`src/admin/reportQueries.ts`, shared by the HTML and CSV forms of each report
so they cannot disagree.

### Consolidations

The first table is every order whose `member_email` differs from its
`order_email`, newest change first; an order the legacy import re-pointed
shows "legacy import" rather than an admin and a date. The second groups
counted orders by lower-cased, trimmed billing name, listing every name that
appears under more than one `member_email` -- usually one person with two
addresses, to be consolidated by attributing their orders to one of them.

### Missing from BigCommerce

Orders the store has stopped returning, with when each was first missed
(los-verdes/card-losverd-es#105). **Nothing on this page has been withdrawn
from anyone**: a flagged order counts towards its member's membership exactly
as it did before, and their card is untouched. The flag exists because
deciding to end somebody's membership is a judgement, and a 404 from an API
is not a good enough reason to make it automatically -- a BigCommerce incident
would otherwise become mass membership loss.

An order is flagged when a webhook prompts a sync and the store answers that
the order no longer exists. The flag clears itself if a later sync finds the
order again, so a 404 during an outage does not leave a mark to tidy up by
hand.

Two things it does not cover. It catches **deletion**, not **archival**: an
archived order simply stops appearing in the order list, and the resync walks
forward from a cursor rather than looking for absences, so nothing notices.
And there is deliberately no button here to stop a flagged order counting --
that is a deliberate withdrawal of a membership, which is
[#31](https://github.com/los-verdes/card-losverd-es/issues/31).

### Slack cross-reference

Members are matched to `slack_users` on lowercased `member_email`, so a member
who joined Slack under another address shows as not in Slack. "Current" and
"lapsed" follow the active and expired pages: whether the member's
latest-expiring order is still in force. Only live human accounts count as
being in Slack: deactivated accounts (`deleted = 1`), bots, app and workflow
users, and accounts without an email (such as Slackbot) are ignored. Guests
and pending invites count. The page shows when the Slack sync last ran, since
until it has run (`SLACK_BOT_TOKEN` set) every member shows as not in Slack.

### Not built yet

| Legacy page | Plan |
| :--- | :--- |
| Membership Cards (cards generated, unique Apple devices, plus web analytics charts) | Low priority. Counts can come from `registrations`/`devices`. The analytics charts are covered by Cloudflare Web Analytics on the member pages (see the README, "What we record about visits"), so they are not rebuilt here. |
| MiniBC Subscriptions | Not started. MiniBC handles renewals, so it knows things about membership status that nothing else records; D1 holds none of it today and the sync job is a stub. |

## Slack members sync

`run_slack_members_etl` (`src/slack/membersEtl.ts`) pages Slack's
`users.list` and upserts into `slack_users`, keeping the legacy table's
columns so report queries carry over. It exists solely for reporting; the
legacy app never had any inbound Slack integration. Deactivated accounts stay
listed by Slack with `deleted = 1`, so there is no pruning step.

Unlike the legacy job, it does not create a login `users` row per Slack
member; join on email instead. It skips itself, with a warning, until
`SLACK_BOT_TOKEN` is set. Staging runs it every six hours against its own
Slack app; production will once it has cron triggers.

## Who is an admin

For now, only the maintainer's own account. The eventual list is the Los Verdes
board (the "Starting XI"), the Merch Team, who administer the storefront and
answer `merchteam@losverdesatx.org`, and the Membership Committee. Those names are published on the
group's website, so the list may be derivable from there rather than
maintained by hand; undecided.
