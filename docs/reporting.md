# Membership reporting

The legacy app's membership reports lived in Google Data Studio, which read
the legacy Postgres database directly through a read-only SQL user. Cutover
retires that database, and Data Studio cannot connect to D1, so reporting is
rebuilt here as **admin-only pages inside the Worker**
([#53](https://github.com/los-verdes/card-losverd-es/issues/53)). Cloudflare
has no Data Studio equivalent, and an export pipeline to keep Data Studio
alive would be one more thing to maintain.

## The data: `membership_orders`

`members` holds only each member's *current* state. Reports need history
("who was a member on a given date"), so `membership_orders` (migration
`0008`) keeps one row per membership order, ever. It is a port of the legacy
`annual_membership` table.

* **`created_on` / `expires_on`**: ISO8601 UTC text. `expires_on` is
  `created_on` + 365 days, stored so that "in force at instant T" is the
  indexed range query `created_on <= T AND expires_on > T`.
* **`order_email` / `member_email`**: the address typed on the order, and the
  address the membership is currently attributed to. They differ when a
  member has changed address, or when one person buys a membership for
  someone else. Reports group people by `member_email`.
* **`status`**: the store's own order status, verbatim. **`test_mode`**:
  Squarespace's test-order flag.
* **`first_seen_via`**: `sync` or `legacy_postgres`.

Two writers fill it, and converge on the same rows because both use the
legacy key format (`{id}_bc` for BigCommerce, the raw order id for
Squarespace):

1. **The BigCommerce sync** (`src/bigcommerce/orders.ts`) records every
   membership order it processes, from webhooks and scheduled resyncs alike.
   A resync refreshes the store's fields (so a refund lands) but never
   overwrites `member_email`.
2. **The one-time legacy export** (`scripts/legacy-export/`) carries every
   legacy order, BigCommerce and Squarespace. It is the only surviving record
   of Squarespace-era orders, so it must run before the legacy database is
   decommissioned. For an order the sync already recorded, it only fills in
   `member_email`.

### What counts as a membership

Reports leave out Squarespace test orders and any order whose status is
`canceled`, `cancelled`, `refunded`, or `declined` (case-insensitive;
`VOID_STATUSES` in `src/admin/reportQueries.ts`). The legacy app only
excluded Squarespace's `CANCELED`.

Note this is a reporting rule only. The `members` sync does not currently
look at order status, so a refunded order still yields an active card.

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
| `/admin/reports/slack` | Four tables: current members in Slack, current members not in Slack, lapsed members in Slack, and Slack users with no membership orders. Current snapshot only; each table downloads separately (`?table=...&format=csv`). | Slack User Stuff |

Common filters on the active and expired pages: `q` (matches either email
or the billing name) and `channel`. SQL lives in
`src/admin/reportQueries.ts`, shared by the HTML and CSV forms of each report
so they cannot disagree.

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
| Membership Consolidations (orders whose member email differs; possible duplicates by billing name) | Next, together with a way for an admin to **re-point an order's `member_email`**. That is a required feature, not just a view: it is how a membership bought as a gift gets attributed to its recipient. Open design point: the recipient also needs a `members` row to get a card, and `members` is currently derived from the order's billing email alone. |
| Membership Cards (cards generated, unique Apple devices, plus web analytics charts) | Low priority. Counts can come from `registrations`/`devices`. For the analytics charts, use Cloudflare Web Analytics rather than rebuilding them. |
| MiniBC Subscriptions | After cutover. MiniBC handles renewals, so it knows things about membership status that nothing else records; D1 holds none of it today and the sync job is a stub. |

## Slack members sync

`run_slack_members_etl` (`src/slack/membersEtl.ts`) pages Slack's
`users.list` and upserts into `slack_users`, keeping the legacy table's
columns so report queries carry over. It exists solely for reporting; the
legacy app never had any inbound Slack integration. Deactivated accounts stay
listed by Slack with `deleted = 1`, so there is no pruning step.

Unlike the legacy job, it does not create a login `users` row per Slack
member; join on email instead. It skips itself, with a warning, until
`SLACK_BOT_TOKEN` is set, and only runs on a schedule once cron triggers are
enabled.

## Who is an admin

For now, only Jeff. The eventual list is the Los Verdes board (the
"Starting XI") and the membership committee. Those names are published on the
group's website, so the list may be derivable from there rather than
maintained by hand; undecided.
