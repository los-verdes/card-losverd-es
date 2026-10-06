# BigCommerce Order Ingestion — Design

How orders get from the BigCommerce store into D1: the webhook, the
`etl-sync` Cloudflare Queue it feeds, and the scheduled resyncs that repair
whatever a webhook missed.

Guiding constraint: **D1 is a refreshable cache of BigCommerce,
not a system of record.** Every write described below is an idempotent
upsert keyed on stable identifiers, never a careful stateful migration —
drift is expected and self-heals on the next webhook delivery or scheduled
resync. That holds for what the store says. D1 is now the only record of
Squarespace-era orders and of what admins and members set here
(attributions, overrides, revocations), since the legacy database was
deleted on 2026-10-05.

## 1. Worker routes

`src/bigcommerce/routes.ts` exports a Hono sub-app mounted at `/bigcommerce`:

### `POST /bigcommerce/order-webhook`

Mirrors the legacy app's `member_card/routes/bigcommerce.py::order_webhook`, ported
to Workers:

1. Parse the JSON body. Reject (400) if it isn't valid JSON or is missing
   `data.type`, `producer`, or `store_id`.
2. Derive `storeHash` from `producer` (`"stores/{hash}"`) and compare
   against the configured `BIGCOMMERCE_STORE_HASH` var. Mismatch → 403.
3. **Validate the webhook's authenticity.** BigCommerce does not sign
   webhook payload bodies with a computable HMAC the way e.g. Shopify does
   — the mechanism the existing Python app actually relies on (see
   `member_card/commands.py::ensure_order_webhook` and
   `member_card/bigcommerce.py::generate_webhook_token`) is a **custom
   shared-secret header**, set once at webhook-subscription-creation time
   via BigCommerce's `headers` field on `Webhooks.create()`:
   `Authorization: bearer <token>`, where
   `token = base64(HMAC-SHA256(key=SIGNING_KEY, data="{storeHash}.{clientId}"))`.
   On receipt, the Worker recomputes the same HMAC and compares it to the
   incoming `Authorization` header with a constant-time comparison
   (`crypto.subtle` + timing-safe compare, not `===`). Mismatch → 401.
   - **New dedicated secret, not reused:** `BIGCOMMERCE_WEBHOOK_SIGNING_KEY`.
     The old app reused Flask's single `SECRET_KEY` for this (and for
     session signing, and for QR verification). This site already
     splits that single key into `SESSION_SIGNING_KEY` and
     `PASS_SIGNATURE_KEY` for the same reason; this design adds a third,
     purpose-specific secret rather than resurrecting the old
     one-key-for-everything pattern. It was generated fresh, not carried over
     from the previous site's `SECRET_KEY`, and each store's webhook was
     registered with the token derived from it.
   - **Registration:** `just bigcommerce-ensure-webhook <env>`
     (`scripts/bigcommerce-webhook.mjs`, a port of the legacy
     `ensure-order-webhook` command) creates or updates the store's
     `store/order/*` webhook with the header. It computes the token with
     the Worker's own `src/bigcommerce/webhookToken.ts` (Node imports the
     TypeScript directly), so registration and verification can't drift.
   - Verified against real deliveries: the sandbox store's webhook drives
     staging, and production's has pointed at `card.losverd.es` since the
     cutover. The specs (`sync.spec.ts`/`routes.spec.ts`) exercise the same
     pure `signWebhookToken`/`verifyWebhookAuthorization` helpers against a
     locally generated key.
4. If `data.type === "order"`, check `data.id` is a positive integer, which
   is all a BigCommerce order id ever is. Reject (400) otherwise. The id is
   interpolated into the API path the sync later fetches, and a URL
   normalises `..` away rather than rejecting it, so an id carrying dot
   segments would address a different endpoint with this store's access
   token attached. Reaching that needs the webhook token verified in step 3,
   so this is a second lock rather than the only one -- the client encodes
   ids into the path as well. It also means a malformed id is answered here
   rather than becoming a queue message that retries five times and
   dead-letters.
5. Enqueue `{ type: "sync_bigcommerce_order", orderId: data.id, storeHash }`
   onto `ETL_SYNC_QUEUE` (see §3) and return `200` immediately — **no inline
   sync work happens in the request**, matching the legacy Python app's
   behavior of acking fast and syncing
   out-of-band.
6. Any other `data.type` (e.g. `customer`) is logged and acked 200 with no
   further action — same as the legacy Python app's `else` branch (`No handler
   available for {data_type}`), since only orders drive membership state.

The store app's install callbacks (`/bigcommerce/app/auth`, `/load`,
`/uninstall`, in `src/bigcommerce/app.tsx`) belong to the store integration
(#38), not order ingestion.

## 2. Idempotent upsert into `members`

Every membership order is first recorded in the `membership_orders` history
table (`src/bigcommerce/orders.ts`; see [`reporting.md`](reporting.md)).
Then the member's `members` row is **re-derived from their whole order
history**, not merged with the one order just synced. History goes first
because it is idempotent: if a later step throws, the queue's retry rewrites
the same row.

`src/bigcommerce/sync.ts::refreshMemberFromOrders()` reads every order of the
member's (`membership_orders.member_email`, which may differ from the order's
billing email) that **counts as a membership** -- the same rule the reports
use (`COUNTS_AS_MEMBERSHIP` in `src/lib/membershipOrders.ts`) -- and maps
them to one `members` row. A BigCommerce order counts only on a positively
paid status; a Squarespace-era one carries the verdict it was given at import
(`frozen_counts`). `docs/membership-card-provenance.md` is where the statuses
themselves are listed, and is the document to change if they move. Deriving from history is what lets a refund take effect (the
refunded renewal simply stops counting), and it makes the result independent
of the order in which orders sync: webhooks and the scheduled resync don't
deliver them chronologically.

| `members` column | Source | Notes |
| :--- | :--- | :--- |
| `member_id` | A random `LV-{uuid}` if inserting a brand-new row | It's the serial number / object id baked into every Apple and Google Wallet pass issued for that member, so it must identify exactly one member and never change: a row matched by email keeps its **existing** `member_id`. Not derived from the BigCommerce customer id (#66): guest checkouts all have `customer_id` 0, and an order attributed to someone else carries the buyer's. Rows are always found by email, so the id never needs to be reproducible. |
| `first_name` / `last_name` | Billing name on the member's latest counted order | Same field the Python `insert_order_as_membership()` uses. Falls back to the stored name (or, for a new row, the synced order's) when that order has none, e.g. a Squarespace-era row. |
| `email` | `membership_orders.member_email` (lower-cased; the billing email unless re-pointed) | Matches `customer_email = order["billing_address"]["email"].lower()` in `member_card/bigcommerce.py`. |
| `expiration_date` | Latest counted order's `created_on + 365 days`, `YYYY-MM-DD`; `NULL` if no order counts | Directly ports `AnnualMembership.expiry_date` (`created_on + timedelta(days=365)`). Can move earlier, when a renewal is refunded. |
| `member_since` | Earliest counted order's `created_on`, `YYYY-MM-DD`; `NULL` if no order counts | Includes Squarespace-era orders, which the one-time legacy import loaded. `member_since_overrides` still wins when a pass is rendered. |
| `auth_token` | Preserved unchanged on update; freshly generated (`crypto.randomUUID()`) only on insert | `auth_token` is Apple PassKit device-auth state, not BigCommerce data — a resync must never rotate it out from under an already-installed pass. |
| `last_updated_at` | `Date.now()`, only when a pass-visible field changed | Cache-validation timestamp Apple's update-polling endpoint compares against. |
| `created_at` | DB default | Untouched on update. |

Whether a membership is active or expired is not stored: it is answered from
`expiration_date` when somebody asks (`effectiveStatus()` in
`src/member/artifacts.ts`).

A member whose orders all stop counting (every one refunded, say) keeps their
row -- and so their `member_id`, auth token, and device registrations, should
they buy again -- with a `NULL` expiration, so their card is no longer
current. No row is created for an email with no counted orders.

**Upsert strategy:** members are keyed by `email`. Look up the existing row
by email; update it in place if found (preserving `member_id`, `auth_token`,
`created_at`), otherwise insert a new row with a random `member_id`. The
insert carries `ON CONFLICT(email) DO UPDATE`, so if two syncs for the same
new member overlap between the lookup and the insert, the row that got there
first keeps its id and token and takes the same derived state. Running the
same order through this path any number of times converges to the same row --
the idempotency property the tests in §4 assert directly.

### Orders BigCommerce no longer has

A webhook fires for a deleted order like any other, and the sync's fetch
then 404s. That is a fact about the store rather than a failure, so it is
not retried: the order's row is flagged with `missing_since`, Slack is told
once, and the message is acked. Nothing is retried five times to reach the
same answer.

**A flagged order still counts towards its member's membership**, and their
card is untouched (decided 2026-09-18, los-verdes/card-losverd-es#105).
Revoking a membership on the strength of one API response would turn a
BigCommerce incident into members losing their cards en masse; the flag
raises it for a person instead, on the "Missing from BigCommerce" report.
A later sync that finds the order again clears the flag, so a transient 404
heals itself.

This catches an order that really disappears, which in practice BigCommerce
does not do: deleting an order there archives it. An archived order is still
returned, by the order list and by its own id, marked `is_deleted: true`, and
archiving it fires a webhook like any other change (checked on a sandbox
order, 2026-09-21). The sync does not read `is_deleted`, so an archived
order is re-applied unchanged and keeps counting, with nothing flagged.
Whether an archived order should count is an open question in the
provenance document.

## 3. Integration with the `etl-sync` queue

The webhook route's only job is to validate and
enqueue `{ type: "sync_bigcommerce_order", orderId, storeHash }` onto
`ETL_SYNC_QUEUE`. The `etl-sync` and `etl-sync-dlq` queues are provisioned by
`terraform/queues.tf`, with their bindings in `wrangler.toml`:

* `src/queues/etlSync.ts` defines the `EtlSyncMessage` discriminated union
  and `enqueueEtlSync(env, message)` — a thin
  wrapper around `env.ETL_SYNC_QUEUE.send(message)`.
* `src/queues/etlSync.ts` also exports the `queue()` consumer entrypoint
  (`handleEtlSyncBatch`), which dispatches each message's `type` to the
  matching `sync.ts` function and acks or retries each message on its
  own, so one failure doesn't retry the rest of its batch. `src/queues/index.ts` routes the Worker's single
  `queue()` entrypoint to it by queue name, and acks, logs and raises a Slack alert for
  anything that reaches `etl-sync-dlq`.

### Card emails for new orders

When the webhook path (and only the webhook path) sees an order that counts
as a membership -- the paid statuses (`PAID_BIGCOMMERCE_STATUSES`), which are
the card's list less `Partially Refunded` -- the member is emailed their card once
(`src/email/newOrder.ts`). Emailing in bulk would be a disaster -- a
backfill, resync or data reload would mail hundreds of existing members -- so three guards each stop that on their own:

1. only `syncBigCommerceOrder` calls it; the scheduled and `loadAll`
   resyncs go straight to `applyMembershipOrder`, and the legacy import
   writes D1 without running either;
2. `CARD_EMAIL_NEW_ORDERS_SINCE`, a plain var that is **empty by default**,
   switches sending on and limits it to orders created on or after that date;
3. `card_emails` records the order *before* the send, so a
   webhook retry or duplicate delivery finds the row and stops.

Removing any one of them fails a test. A send that fails is logged and not
retried, keeping "at most one email per order"; that member can still use
`/email-card`.

## 4. Scheduled full resync (`src/scheduled.ts`)

A `scheduled()` handler maps each cron trigger to an
`EtlSyncMessage` and enqueues it (same `enqueueEtlSync` helper). Other
scheduled jobs share the queue but are not BigCommerce's concern:
`run_slack_members_etl` (see [`reporting.md`](reporting.md)), the weekly
readiness check, the daily pass-expiry sweep and the hourly ops watch. Of
the jobs here, `sync_subscriptions_etl` and `sync_minibc_subscriptions_etl`
are implemented in full; `sync_customers_etl` is a stub and not scheduled.

* **`sync_subscriptions_etl` — fully implemented** (`src/bigcommerce/sync.ts::syncSubscriptionsEtl`).
  Chosen as the one full example because it's the direct self-healing
  counterpart to the webhook path and the one the guiding constraint above
  leans on hardest ("a scheduled resync can always repair drift"): it walks
  `GET /v2/orders` for a trailing window (`min_date_modified`, mirroring
  `member_card/bigcommerce.py::bigcommerce_orders_etl`'s "last run time
  minus 12 hours" overlap window, using a D1-stored watermark in place of
  Postgres's `table_metadata`), or the whole store with `loadAll`, and runs
  every membership order through the exact same `refreshMemberFromOrders()`
  path §2 describes. Concurrency is capped at 1 by the `etl-sync` queue
  config so this can never race a webhook-triggered
  `sync_bigcommerce_order` on the same D1 rows.

  **A run is a chain of queue messages** (#57), because the store has more
  orders than one Worker invocation can process:
  * Each message fetches one page of up to 250 orders in id order
    (`min_id` + `sort=id:asc`; an id cursor, since page numbers shift when
    orders change mid-run), and stops early after 120 membership orders to
    stay well inside D1's per-invocation query limit (the arithmetic is in
    the code comment on `MAX_MEMBERSHIP_ORDERS_PER_MESSAGE`).
  * If there is more to do, it enqueues a follow-up message carrying a
    `cursor`: the last order id processed, the `min_date_modified` filter
    fixed at the chain's start, and the chain's start time. The follow-up is
    sent only after the slice succeeds; a retried message redoes its slice,
    which is harmless because every write is an idempotent upsert.
  * Only the chain's last message (a short page) sets the watermark, to the
    chain's start time, and the watermark never moves backwards (an
    incremental chain can finish while a long `loadAll` chain is still
    running). A chain that trips a safety backstop (500 messages, or
    BigCommerce ignoring `min_id`) logs an error and ends *without* touching
    the watermark.
  * The BigCommerce client waits out `429` responses (up to 5 waits of at
    most 30s, per `X-Rate-Limit-Time-Reset-Ms`): the store's rate limit is
    shared by every app on it, and a queue retry would just hit it again.

  **It runs on two schedules** (#347): every six hours incrementally
  (`15 */6 * * *`), and every Sunday at 04:45 UTC as a full resync
  (`45 4 * * SUN`, `loadAll`). The full one is a backstop against drift the
  incremental one cannot see -- a change to how membership is worked out,
  which otherwise reaches only members whose orders change afterwards, or a
  row changed by hand -- so:
  * it counts the cards it changes across the chain, logs each ("Full
    resync: order ..."), and posts a count to Slack when there are any;
  * its last message enqueues `recheck_unlisted_orders`, which re-reads, 50
    to a message, each BigCommerce order held here that counts as a
    membership and whose `updated_at` is older than the chain's start
    (recording an order always moves it, so these are the ones the store's
    list did not return). Only counting orders: `GET /v2/orders` leaves out
    Incomplete orders unless asked for `status_id=0`, and `GET /v2/orders/{id}`
    answers 404 for an old one (checked against the staging store,
    2026-09-27), so re-reading them would flag every old abandoned checkout
    as missing. Each goes through
    `readOrderFromStore`, which flags an order the store no longer has
    (`flagOrderMissingFromStore`) and never emails anyone; the webhook path
    that can email is not reachable from here;
  * every message of both parts updates the run's row in `full_resyncs`
    (migration `0017`): orders read and cards changed so far, then the
    re-reads, then when it finished. The readiness page's "Full resync"
    signal reads it, showing a running one's progress or how the last one
    ended, and fires when a running one has made no progress for two hours,
    or none has finished for eight days.

  Start a full resync by hand with `just etl-run <env> full-resync` (with
  `--yes-production` for production), which
  enqueues `{ "type": "sync_subscriptions_etl", "loadAll": true }`.
* **`sync_customers_etl` — stubbed, and not scheduled.** High-level: page through
  `GET /v2/customers`, and for any customer whose email matches an
  existing `members` row with no linkage yet, backfill/correct identity
  fields (mirrors `member_card/bigcommerce.py::customer_etl`'s
  `map_customer_to_user_by_store_id`). Still a stub. In the legacy app this
  job is also what re-pointed a member at their current storefront email;
  here that role belongs to `membership_orders.member_email`, which an
  admin re-points by attributing the order (the provenance document covers
  gifts and re-attribution).
* **Each order's MiniBC subscription.** MiniBC writes a `minibc` metafield,
  `subscription_id`, onto every order it creates, the first and each renewal,
  a few minutes after the order itself. Whenever a membership order is
  applied (webhook, resync, or an admin's re-read), the sync reads it
  (`GET /v3/orders/{id}/metafields?namespace=minibc&key=subscription_id`)
  into `membership_orders.minibc_subscription_id`, with `minibc_checked_at`
  recording when it asked. An order is not asked again once it has one, or
  once it was asked a day or more after it was placed and had none. It is the
  first way a MiniBC subscription is tied to a member (`src/minibc/renewals.ts`,
  #397). A failed read is logged and asked again on
  the next sync; it never fails the order's own sync.
* **`sync_minibc_subscriptions_etl` — MiniBC's membership subscriptions,
  twice a day** (`40 */12 * * *`, `src/minibc/subscriptions.ts`, #397). Reads
  every subscription to each of `MEMBERSHIP_SKUS` through MiniBC's
  `POST /subscriptions/search` (50 a page, ten pages a message, chained like
  the resync) into `minibc_subscriptions`: status, signup, next payment,
  paused and cancelled dates, the order that started it and the store
  customer paying for it -- none of its names, addresses or payment details. Its
  email is kept only as a hint at the member for a subscription no order
  matches (#470), and never matches anything. A subscription a complete read no longer lists is flagged
  (`missing_since`), not deleted. It is informational only: renewals already
  arrive as the BigCommerce orders MiniBC creates, and nothing here changes a
  card or emails anyone. Without `MINIBC_API_KEY` (staging) it logs that and
  stops. The key can also cancel subscriptions and charge cards; the client
  only searches. Admins see it on the Renewals report and each member's admin page (see
  [`reporting.md`](reporting.md)).

## 5. What's deferred

* **`sync_customers_etl`'s implementation** — stubbed with a high-level
  description (§4).
