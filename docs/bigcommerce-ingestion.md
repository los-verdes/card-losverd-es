# BigCommerce Order Ingestion — Design

Design for the "Order Ingestion" row of the Target Architecture Overview in
the migration plan (tracked separately from this repo). Follows the
conventions already established by Phase 2.3 (Member Auth) and Phase 2.5
(Async/Background Processing) — in particular, this is the producer Phase
2.5.5 already names for the `etl-sync` Cloudflare Queue.

Guiding constraint (Phase 2.2): **D1 is a refreshable cache of BigCommerce,
not a system of record.** Every write described below is an idempotent
upsert keyed on stable identifiers, never a careful stateful migration —
drift is expected and self-heals on the next webhook delivery or scheduled
resync.

## 1. Worker routes

`src/bigcommerce/routes.ts` exports a Hono sub-app mounted at `/bigcommerce`:

### `POST /bigcommerce/order-webhook`

Mirrors today's `member_card/routes/bigcommerce.py::order_webhook`, ported
to Workers:

1. Parse the JSON body. Reject (400) if it isn't valid JSON or is missing
   `data`, `data.type`, `producer`, `scope`, or `store_id`.
2. Derive `storeHash` from `producer` (`"stores/{hash}"`) and compare
   against the configured `BIGCOMMERCE_STORE_HASH` secret. Mismatch → 403.
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
     session signing, and for QR verification). Phase 2.3.1 already
     splits that single key into `SESSION_SIGNING_KEY` and
     `PASS_SIGNATURE_KEY` for the same reason; this design adds a third,
     purpose-specific secret rather than resurrecting the old
     one-key-for-everything pattern. It must be regenerated and the
     webhook subscription recreated with the new token at cutover (Phase
     8) — it cannot be carried over from GCP's `SECRET_KEY` since that
     value is being retired entirely.
   - Deferred: real verification against a live secret. There's no
     BigCommerce sandbox store or webhook subscription available in this
     environment, so `sync.spec.ts`/`routes.spec.ts` exercise the HMAC
     logic against a locally-generated key/token pair, not a token BigCommerce
     itself issued. The `signWebhookToken`/`verifyWebhookSignature` helpers
     are pure functions, so this is a config/secrets exercise at cutover,
     not a code change.
4. If `data.type === "order"`, enqueue
   `{ type: "sync_bigcommerce_order", orderId: data.id, storeHash }` onto
   `ETL_SYNC_QUEUE` (see §3) and return `200` immediately — **no inline
   sync work happens in the request**, matching Phase 2.5.5's stated
   design and today's Python behavior of acking fast and syncing
   out-of-band.
5. Any other `data.type` (e.g. `customer`) is logged and acked 200 with no
   further action — same as today's Python `else` branch (`No handler
   available for {data_type}`), since only orders drive membership state
   today.

No other BigCommerce OAuth/install routes (`/bigcommerce/callback`,
`/bigcommerce/load`, `/bigcommerce/uninstall`, `/bigcommerce/remove-user`)
are in scope here — those belong to the single-tenant admin-app-install
flow, which is a Member Auth / admin-tooling concern, not order ingestion.

## 2. Idempotent upsert into `members`

`src/bigcommerce/sync.ts::upsertMemberFromOrder()` maps one BigCommerce
order to one `members` row:

| `members` column | Source | Notes |
| :--- | :--- | :--- |
| `member_id` | `BC-{customer_id}` if inserting a brand-new row | Stable, deterministic, regenerable from BigCommerce alone — satisfies Phase 2.2's "resync can always repair drift." If a row is matched by email instead (see below), the **existing** `member_id` is preserved rather than overwritten: it's the serial number / object id baked into every Apple and Google Wallet pass issued for that member, so a later resync must never change it. |
| `first_name` / `last_name` | `order.billing_address.first_name/.last_name` | Same field the Python `insert_order_as_membership()` uses. |
| `email` | `order.billing_address.email`, lower-cased | Matches `customer_email = order["billing_address"]["email"].lower()` in `member_card/bigcommerce.py`. |
| `membership_tier` | SKU of the first order line item matching a configured `MEMBERSHIP_SKU_TIER_MAP` entry | The Python app treats membership as effectively single-tier (`BIGCOMMERCE_MEMBERSHIP_SKUS`, default `LOSV-MEM-0001`); the D1 schema comment already anticipates more (`standard`, `los-pringles`, `cut-crew`), so this design introduces an explicit SKU→tier map (a plain object literal for now) rather than assuming one SKU. An order with no matching SKU is not a membership order and is skipped (ack'd, no D1 write) — mirrors the Python ETL's `ignored_line_items` filtering. |
| `status` | `'active'` if the (merged) `expiration_date >= today`, else `'expired'` | Mirrors `AnnualMembership.is_active` (created_on within the last 365 days) across *all* of a member's orders, not just the one being synced. The sync never sets `'revoked'`, and doesn't preserve it either: the legacy app has no revocation concept, so a sync re-derives status from expiration like any other row. |
| `expiration_date` | `order.date_created + 365 days`, formatted `YYYY-MM-DD` — but only if later than the existing value | Directly ports `AnnualMembership.expiry_date` (`created_on + timedelta(days=365)`). Only ever moves later: webhooks and the scheduled resync don't deliver orders chronologically (e.g. a status change on an old order re-fires its webhook after a renewal already synced), so an older order must not roll back a renewal. |
| `member_since` | `order.date_created`, formatted `YYYY-MM-DD` — but only if earlier than the existing value | Only ever moves earlier. Besides making out-of-order syncs converge, this is what keeps the migration plan's one-time Squarespace-era `member_since` backfill (Phase 2.2) from being clobbered by a later BigCommerce order. |
| `auth_token` | Preserved unchanged on update; freshly generated (`crypto.randomUUID()`) only on insert | `auth_token` is Apple PassKit device-auth state, not BigCommerce data — a resync must never rotate it out from under an already-installed pass. |
| `last_updated_at` | `Date.now()` | Cache-validation timestamp Apple's polling endpoint (`Phase 4.2`) compares against. |
| `created_at` | DB default | Untouched on update. |

**Upsert strategy:** look up the existing row by `email` first (the
natural join key with any member row that predates this sync, e.g. one
created before the member's BigCommerce customer id was known), falling back to `member_id = BC-{customerId}`
if no email match exists yet. Update in place if found (preserving
`member_id`, `auth_token`, `created_at`); otherwise insert a new row. This
is two sequential D1 statements (`SELECT` then `UPDATE`/`INSERT`), not a
single `INSERT ... ON CONFLICT`, specifically so the match-by-email path
works — SQLite's `ON CONFLICT` only fires on a declared constraint (here,
`member_id` or the `email` unique index individually), and we need
"resolve to whichever row already exists, by either key" semantics that a
single `ON CONFLICT` clause can't express cleanly across two different
candidate keys. Running the same order through this path any number of
times converges to the same row — the idempotency property the tests in
§4 assert directly.

## 3. Integration with the `etl-sync` queue

Per Phase 2.5.4/2.5.5, the webhook route's only job is to validate and
enqueue `{ type: "sync_bigcommerce_order", orderId, storeHash }` onto
`ETL_SYNC_QUEUE`. The `etl-sync` and `etl-sync-dlq` queues are provisioned by
`terraform/queues.tf`, with their bindings in `wrangler.toml`:

* `src/queues/etlSync.ts` defines the `EtlSyncMessage` discriminated union
  (verbatim from Phase 2.5.4) and `enqueueEtlSync(env, message)` — a thin
  wrapper that calls `env.ETL_SYNC_QUEUE.send(message)` **if the binding
  is present**, and otherwise `console.warn`s and no-ops -- which is what
  happens in the `preview` environment, deliberately given no queue
  bindings so it can't steal production's consumer or feed it preview
  traffic.
* `src/queues/etlSync.ts` also exports the `queue()` consumer entrypoint
  (`handleEtlSyncBatch`), which dispatches each message's `type` to the
  matching `sync.ts` function and acks/retries per-message exactly as
  Phase 2.5.2 specifies. `src/queues/index.ts` routes the Worker's single
  `queue()` entrypoint to it by queue name, and acks + logs anything that
  reaches `etl-sync-dlq`.

## 4. Scheduled full resync (`src/scheduled.ts`)

Per Phase 2.5.3, a `scheduled()` handler maps each cron trigger to an
`EtlSyncMessage` and enqueues it (same `enqueueEtlSync` helper, same
"no-op until the queue exists" caveat). Three jobs, one implemented fully
per the task's time-boxing allowance:

* **`sync_subscriptions_etl` — fully implemented** (`src/bigcommerce/sync.ts::syncSubscriptionsEtl`).
  Chosen as the one full example because it's the direct self-healing
  counterpart to the webhook path and the one Phase 2.2 leans on hardest
  ("a scheduled resync can always repair drift"): it pages through
  `GET /v2/orders?min_date_modified=...` for a trailing window (mirrors
  `member_card/bigcommerce.py::bigcommerce_orders_etl`'s "last run time
  minus 12 hours" overlap window, using a D1-stored watermark in place of
  Postgres's `table_metadata`), and runs every order through the exact
  same `upsertMemberFromOrder()` path §2 describes. Concurrency is capped
  at 1 by the `etl-sync` queue config (Phase 2.5.1) so this can never race
  a webhook-triggered `sync_bigcommerce_order` on the same D1 rows.
* **`sync_customers_etl` — stubbed.** High-level: page through
  `GET /v2/customers`, and for any customer whose email matches an
  existing `members` row with no linkage yet, backfill/correct identity
  fields (mirrors `member_card/bigcommerce.py::customer_etl`'s
  `map_customer_to_user_by_store_id`). Since D1's `members` table has no
  `bigcommerce_id`/user-identity columns yet (those belong to the Member
  Auth `users`/`oauth_identities` tables in Phase 2.3, not this table),
  this job's real implementation is deferred until that schema lands —
  today it would have nothing new to write that `sync_subscriptions_etl`
  doesn't already cover for membership purposes.
* **`sync_minibc_subscriptions_etl` — stubbed.** High-level: call
  MiniBC's REST API (`GET /products/search`, `POST /subscriptions/search`
  per `member_card/minibc.py`) for recurring-subscription state that
  doesn't flow through BigCommerce order webhooks at all, and reconcile
  `membership_tier`/`expiration_date` for members on a MiniBC recurring
  plan. Deferred: no MiniBC API key/sandbox is available in this
  environment to validate request/response shapes against, and MiniBC
  orders are a smaller slice of total membership volume than direct
  BigCommerce orders — lower priority for a first pass.

## 5. What's deferred

* **Real webhook signature verification against a live secret.** The HMAC
  logic is implemented and tested against locally-generated keys; there's
  no BigCommerce store/webhook subscription in this environment to
  validate the exact header format/casing BigCommerce sends in
  production. Verify against a real sandbox store during Phase 1 risk
  spikes or staging validation (Phase 8.2), before cutover.
* **Cron triggers.** Queues are wired (Phase 2.5.2), but `wrangler.toml`
  has no `[triggers] crons` yet: the scheduled jobs would run against
  placeholder BigCommerce credentials until real secrets are set.
* **`sync_customers_etl` and `sync_minibc_subscriptions_etl` full
  implementations** — stubbed with a clear high-level description each
  (§4); `sync_subscriptions_etl` is the one fully implemented, working
  example.
* **Admin app-install/OAuth routes** (`/bigcommerce/callback`, `/load`,
  `/uninstall`, `/remove-user`) — out of scope for order ingestion; see §1.
