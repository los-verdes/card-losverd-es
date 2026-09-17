import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";
import { notifyPassUpdated } from "../passkit/updates";
import { recordMembershipOrder } from "./orders";

const BC_API_BASE = "https://api.bigcommerce.com/stores";

// SKU -> membership tier. The Python app currently treats membership as
// effectively single-tier (`BIGCOMMERCE_MEMBERSHIP_SKUS`, default
// `LOSV-MEM-0001`, from `member_card/settings.py`); the D1 schema comment
// on `members.membership_tier` already anticipates more tiers
// (standard/los-pringles/cut-crew), so this is an explicit map rather than
// a single hardcoded SKU. Extend this as new membership SKUs are added to
// the BigCommerce catalog.
export const MEMBERSHIP_SKU_TIER_MAP: Record<string, string> = {
  "LOSV-MEM-0001": "standard",
};

export interface BigCommerceAddress {
  first_name: string;
  last_name: string;
  email: string;
}

export interface BigCommerceOrder {
  id: number;
  customer_id: number;
  status: string;
  date_created: string;
  date_modified: string;
  billing_address: BigCommerceAddress;
  // Reporting-only fields (src/bigcommerce/orders.ts). Optional: nothing
  // membership-critical depends on them.
  cart_id?: string | null;
  order_source?: string;
}

export interface BigCommerceOrderProduct {
  id: number;
  product_id: number;
  sku: string;
  name: string;
}

// BigCommerce's maximum `limit` for list endpoints
// (https://docs.bigcommerce.com/developer/api-reference/rest/overview#pagination-and-limit).
export const ORDERS_PAGE_SIZE = 250;

// BigCommerce rate-limits each store on a 30-second window, shared by every
// app on the store (150 requests on Standard/Plus plans:
// https://docs.bigcommerce.com/developer/docs/overview/api-fundamentals/rate-limits).
// One resync message can make ~250 requests, so a 429 waits out the window
// (per the `X-Rate-Limit-Time-Reset-Ms` header) rather than failing the whole
// slice back to the queue, whose retry would just hit the limit again.
const MAX_RATE_LIMIT_WAITS = 5;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

function bcHeaders(accessToken: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Auth-Token": accessToken,
  };
}

/**
 * Minimal fetch()-based BigCommerce v2 REST API client. Deliberately not a
 * port of the Python `bigcommerce`/`minibc` client libraries (Python-
 * specific, per the Target Architecture Overview's "Order Ingestion" row)
 * - just the handful of endpoints this ingestion path needs.
 */
export class BigCommerceClient {
  constructor(
    private readonly storeHash: string,
    private readonly accessToken: string,
  ) {}

  private url(path: string, query?: URLSearchParams): string {
    const base = `${BC_API_BASE}/${this.storeHash}/v2/${path}`;
    return query ? `${base}?${query.toString()}` : base;
  }

  /** GET, waiting out (a bounded number of) rate-limit 429s. */
  private async get(path: string, query?: URLSearchParams): Promise<Response> {
    for (let waits = 0; ; waits++) {
      const res = await fetch(this.url(path, query), {
        headers: bcHeaders(this.accessToken),
      });
      if (res.status !== 429 || waits >= MAX_RATE_LIMIT_WAITS) return res;
      await res.body?.cancel();
      const waitMs = Math.min(
        Number(res.headers.get("X-Rate-Limit-Time-Reset-Ms")) ||
          MAX_RATE_LIMIT_WAIT_MS,
        MAX_RATE_LIMIT_WAIT_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async getOrder(orderId: number | string): Promise<BigCommerceOrder> {
    const res = await this.get(`orders/${orderId}`);
    if (!res.ok) {
      throw new Error(
        `BigCommerce getOrder(${orderId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }

  async getOrderProducts(
    orderId: number | string,
  ): Promise<BigCommerceOrderProduct[]> {
    const res = await this.get(`orders/${orderId}/products`);
    if (res.status === 204) return [];
    if (!res.ok) {
      throw new Error(
        `BigCommerce getOrderProducts(${orderId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }

  /**
   * One page of the v2 orders list in ascending id order, starting at
   * `minId`, optionally filtered (e.g. `min_date_modified`). An id cursor
   * rather than page numbers: pages shift when orders are created or
   * modified mid-resync, ids don't.
   */
  async listOrdersPage(
    minId: number,
    params: Record<string, string> = {},
  ): Promise<BigCommerceOrder[]> {
    const query = new URLSearchParams({
      min_id: String(minId),
      sort: "id:asc",
      limit: String(ORDERS_PAGE_SIZE),
      ...params,
    });
    const res = await this.get("orders", query);
    // BigCommerce's v2 API returns 204 (not an empty array) when nothing matches.
    if (res.status === 204) return [];
    if (!res.ok) {
      throw new Error(
        `BigCommerce listOrders(min_id=${minId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }
}

interface MembershipLineItem {
  tier: string;
  product: BigCommerceOrderProduct;
}

/** The order's first membership line item, if it has one. */
function resolveMembership(
  products: BigCommerceOrderProduct[],
): MembershipLineItem | null {
  for (const product of products) {
    const tier = MEMBERSHIP_SKU_TIER_MAP[product.sku];
    if (tier) return { tier, product };
  }
  return null;
}

function computeStatus(
  expirationDate: string | null,
  now: Date,
): "active" | "expired" {
  return expirationDate !== null &&
    expirationDate >= now.toISOString().slice(0, 10)
    ? "active"
    : "expired";
}

/** The `membership_orders` columns a member's card is derived from. */
export interface CountedMembershipOrder {
  created_on: string;
  expires_on: string;
  sku: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface MembershipState {
  status: "active" | "expired";
  /** `YYYY-MM-DD`; null when no order counts (e.g. every order was refunded). */
  expirationDate: string | null;
  memberSince: string | null;
  /** From the latest counted order; null when it doesn't say (e.g. a Squarespace-era row). */
  membershipTier: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * A member's card state, derived from every order of theirs that counts as a
 * membership (`COUNTS_AS_MEMBERSHIP`: not refunded, cancelled, declined, or a
 * test order). Deriving from the whole history, rather than merging one order
 * at a time into the stored row, is what lets a refund take effect: a
 * refunded renewal's expiration simply stops counting. It also makes the
 * result independent of the order in which orders sync (webhooks and the
 * scheduled resync don't deliver them chronologically):
 *
 * - `member_since` is the earliest counted order (Squarespace-era orders from
 *   the legacy import included); `member_since_overrides` still wins when a
 *   pass is rendered.
 * - `expiration_date` is the latest counted order's expiry, and `status` is
 *   derived from it -- mirroring the Python app's "any membership still
 *   active" semantics.
 * - Name and tier come from the latest counted order.
 *
 * ISO timestamps sort chronologically, so plain string comparison is correct.
 */
export function deriveMembershipState(
  orders: CountedMembershipOrder[],
  now: Date = new Date(),
): MembershipState {
  if (orders.length === 0) {
    return {
      status: "expired",
      expirationDate: null,
      memberSince: null,
      membershipTier: null,
      firstName: null,
      lastName: null,
    };
  }
  let earliest = orders[0];
  let latest = orders[0];
  let expiresOn = orders[0].expires_on;
  for (const order of orders) {
    if (order.created_on < earliest.created_on) earliest = order;
    if (order.created_on > latest.created_on) latest = order;
    if (order.expires_on > expiresOn) expiresOn = order.expires_on;
  }
  const expirationDate = expiresOn.slice(0, 10);
  return {
    status: computeStatus(expirationDate, now),
    expirationDate,
    memberSince: earliest.created_on.slice(0, 10),
    membershipTier: (latest.sku && MEMBERSHIP_SKU_TIER_MAP[latest.sku]) || null,
    firstName: latest.first_name || null,
    lastName: latest.last_name || null,
  };
}

/** Identity fields from the order being synced, used where the history doesn't say. */
export interface MemberFallback {
  customerId: number;
  firstName: string;
  lastName: string;
  membershipTier: string;
}

export interface MemberUpsertResult {
  memberId: string;
  /**
   * Whether anything shown on the member's pass changed. Unchanged rows
   * aren't rewritten at all, so `last_updated_at` -- which drives Wallet's
   * "passes updated since" polling and the R2 pass cache -- only moves on
   * real changes, and a routine resync doesn't make every device re-download
   * its pass.
   */
  passChanged: boolean;
}

/**
 * Re-derives one member's `members` row from their `membership_orders`
 * history (see `deriveMembershipState`, and docs/bigcommerce-ingestion.md
 * section 2 for the column-by-column mapping).
 *
 * Matches by `email` first (the natural join key with any member row that
 * predates this sync, whose `member_id` must be preserved). Falls back to
 * inserting a new row keyed by a deterministic `BC-{customerId}` id when no
 * match exists. Never touches `auth_token` or `created_at` on an update -
 * those represent Apple/Google Wallet pass state that sync code must never
 * regenerate.
 *
 * A member whose orders all stop counting keeps their row (and so their
 * `member_id`, auth token, and device registrations, should they buy again),
 * with a null expiration so their card is no longer current. Returns null,
 * creating nothing, for an email with no counted orders and no member row.
 */
export async function refreshMemberFromOrders(
  env: Env,
  memberEmail: string,
  fallback: MemberFallback,
): Promise<MemberUpsertResult | null> {
  const email = memberEmail.trim().toLowerCase();
  const now = Date.now();

  const { results: orders } = await env.DB.prepare(
    `SELECT created_on, expires_on, sku, first_name, last_name
     FROM membership_orders WHERE member_email = ? AND ${COUNTS_AS_MEMBERSHIP}`,
  )
    .bind(email)
    .all<CountedMembershipOrder>();
  const state = deriveMembershipState(orders);

  const existing = await env.DB.prepare(
    `SELECT member_id, first_name, last_name, membership_tier, status, expiration_date, member_since
     FROM members WHERE email = ?`,
  )
    .bind(email)
    .first<{
      member_id: string;
      first_name: string;
      last_name: string;
      membership_tier: string;
      status: string;
      expiration_date: string | null;
      member_since: string | null;
    }>();

  if (existing) {
    const firstName = state.firstName ?? existing.first_name;
    const lastName = state.lastName ?? existing.last_name;
    const membershipTier = state.membershipTier ?? existing.membership_tier;
    const unchanged =
      existing.first_name === firstName &&
      existing.last_name === lastName &&
      existing.membership_tier === membershipTier &&
      existing.status === state.status &&
      existing.expiration_date === state.expirationDate &&
      existing.member_since === state.memberSince;
    if (unchanged) {
      return { memberId: existing.member_id, passChanged: false };
    }
    await env.DB.prepare(
      `UPDATE members
       SET first_name = ?, last_name = ?, membership_tier = ?, status = ?, expiration_date = ?, member_since = ?, last_updated_at = ?
       WHERE member_id = ?`,
    )
      .bind(
        firstName,
        lastName,
        membershipTier,
        state.status,
        state.expirationDate,
        state.memberSince,
        now,
        existing.member_id,
      )
      .run();
    return { memberId: existing.member_id, passChanged: true };
  }

  if (state.expirationDate === null) return null;

  const memberId = `BC-${fallback.customerId}`;
  const authToken = crypto.randomUUID();
  // ON CONFLICT is a safety net for a `BC-{customerId}` row that exists under
  // another email (the customer changed their email address) or the TOCTOU
  // gap between the SELECT above and this INSERT - etl-sync's queue
  // concurrency is capped at 1 (Phase 2.5.1) to make the latter rare, not
  // impossible. `state` was derived from this email's history, so it simply
  // replaces what the row held.
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       email = excluded.email,
       membership_tier = excluded.membership_tier,
       status = excluded.status,
       expiration_date = excluded.expiration_date,
       member_since = excluded.member_since,
       last_updated_at = excluded.last_updated_at`,
  )
    .bind(
      memberId,
      state.firstName ?? fallback.firstName,
      state.lastName ?? fallback.lastName,
      email,
      state.membershipTier ?? fallback.membershipTier,
      state.status,
      state.expirationDate,
      state.memberSince,
      authToken,
      now,
    )
    .run();
  // A brand-new member has no installed passes yet; this is only `true` so
  // the rare ON CONFLICT update above is never silently missed.
  return { memberId, passChanged: true };
}

/**
 * Records the order in the `membership_orders` history, re-derives the
 * member's current state from that history, and pushes a pass update if the
 * pass changed. History goes first: it is idempotent, so if a later step
 * throws, the queue's retry simply rewrites the same row. The member updated
 * is the order's `member_email`, which can differ from its billing email.
 */
async function applyMembershipOrder(
  env: Env,
  order: BigCommerceOrder,
  membership: MembershipLineItem,
): Promise<void> {
  const memberEmail = await recordMembershipOrder(
    env,
    order,
    membership.product,
  );
  const result = await refreshMemberFromOrders(env, memberEmail, {
    customerId: order.customer_id,
    firstName: order.billing_address.first_name,
    lastName: order.billing_address.last_name,
    membershipTier: membership.tier,
  });
  if (result?.passChanged) {
    await notifyPassUpdated(env, result.memberId);
  }
}

/**
 * Primary sync path: one BigCommerce order -> one `members` upsert.
 * Producer call site is the webhook route (`src/bigcommerce/routes.ts`),
 * via the `etl-sync` queue (`src/queues/etlSync.ts`).
 */
export async function syncBigCommerceOrder(
  env: Env,
  storeHash: string,
  orderId: number | string,
): Promise<void> {
  const client = new BigCommerceClient(storeHash, env.BIGCOMMERCE_ACCESS_TOKEN);
  const [order, products] = await Promise.all([
    client.getOrder(orderId),
    client.getOrderProducts(orderId),
  ]);

  const membership = resolveMembership(products);
  if (!membership) {
    console.info(
      `syncBigCommerceOrder(${orderId}): no membership SKU found in order line items, skipping`,
    );
    return;
  }

  await applyMembershipOrder(env, order, membership);
}

const SUBSCRIPTIONS_ETL_JOB_NAME = "sync_subscriptions_etl";
// Mirrors `bigcommerce_orders_etl`'s "last run time minus 12 hours" overlap
// window in `member_card/bigcommerce.py`, so an order modified right at the
// edge of the previous run's window is never silently missed.
const DEFAULT_LOOKBACK_HOURS = 12;
// Per-message work bound. A message fetches one page (<= ORDERS_PAGE_SIZE
// orders) and stops early once it has applied this many membership orders.
// Each applied order costs up to 5 D1 queries (membership_orders upsert, the
// member's counted-orders SELECT, members SELECT, members UPDATE/INSERT,
// notifyPassUpdated's devices SELECT) plus one DELETE per device APNs reports
// unregistered, so a message makes at most ~120*5 + 2 watermark queries =
// ~602 D1 queries against D1's 1,000 per Worker invocation
// (https://developers.cloudflare.com/d1/platform/limits/), leaving ~400 for
// device DELETEs. Subrequests (1 list + <= 250 products calls
// + D1 + APNs pushes + 1 queue send) stay far under Workers Paid's 10,000, and
// ~250 BigCommerce requests fit easily in a queue consumer's 15-minute wall
// time (https://developers.cloudflare.com/workers/platform/limits/), even
// waiting out a few rate-limit windows.
export const MAX_MEMBERSHIP_ORDERS_PER_MESSAGE = 120;
// Safety backstop against a chain that never ends (>= 120 orders a message,
// so ~60,000+ orders; the store has ~10,000). Hitting it logs an error and
// ends the chain *without* advancing the watermark.
export const MAX_CHAIN_MESSAGES = 500;

async function getWatermark(env: Env, jobName: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT last_run_at FROM etl_sync_state WHERE job_name = ?",
  )
    .bind(jobName)
    .first<{ last_run_at: number }>();
  return row?.last_run_at ?? null;
}

/**
 * Only ever moves the watermark forward: an incremental chain can start (and
 * finish) while a long `loadAll` chain is still in flight, and the older
 * chain finishing last must not roll the watermark back.
 */
async function setWatermark(
  env: Env,
  jobName: string,
  timestamp: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job_name) DO UPDATE SET
       last_run_at = MAX(etl_sync_state.last_run_at, excluded.last_run_at),
       updated_at = excluded.updated_at`,
  )
    .bind(jobName, timestamp, Date.now())
    .run();
}

/** Continuation state carried from one resync message to the next. */
export interface SubscriptionsEtlCursor {
  /** When the chain's first message started (epoch ms); the watermark once the chain completes. */
  chainStartedAt: number;
  /** The `min_date_modified` filter (epoch ms), fixed at chain start; absent for a `loadAll` chain. */
  modifiedSince?: number;
  /** Highest order id already processed; the next page starts after it. */
  afterId: number;
  /** Messages this chain has run so far, for the MAX_CHAIN_MESSAGES backstop. */
  messages: number;
}

export interface SubscriptionsEtlOptions {
  /** Skip the modified-since filter entirely - a full historical resync (Phase 2.2's initial cache population). */
  loadAll?: boolean;
  /** The previous message's continuation; absent starts a new chain. */
  cursor?: SubscriptionsEtlCursor;
}

export interface SubscriptionsEtlResult {
  ordersProcessed: number;
  /** Set when the chain isn't finished: enqueue a follow-up message carrying it. */
  next?: SubscriptionsEtlCursor;
}

async function startSubscriptionsEtlChain(
  env: Env,
  loadAll: boolean | undefined,
): Promise<SubscriptionsEtlCursor> {
  const cursor = { chainStartedAt: Date.now(), afterId: 0, messages: 0 };
  if (loadAll) return cursor;
  const lookbackMs = DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000;
  const watermark = await getWatermark(env, SUBSCRIPTIONS_ETL_JOB_NAME);
  const since = watermark ?? cursor.chainStartedAt - lookbackMs;
  return { ...cursor, modifiedSince: since - lookbackMs };
}

/**
 * Scheduled full/incremental resync (Phase 2.5.3's `sync_subscriptions_etl`
 * cron message) - the one fully-implemented example of the three scheduled
 * ETL jobs named in Phase 2.5.3 (see docs/bigcommerce-ingestion.md section
 * 4 for why this one and not the other two). Walks BigCommerce's v2 orders
 * list in id order, filtered to orders modified since the last successful
 * run (minus a trailing overlap window), and runs every membership order
 * through the same idempotent `applyMembershipOrder` path as the webhook
 * flow - repeated runs converge, they don't duplicate.
 *
 * One call does one bounded slice (see MAX_MEMBERSHIP_ORDERS_PER_MESSAGE) of
 * a chain of queue messages: it returns `next` for the caller to enqueue, and
 * only the chain's final slice sets the watermark, to the chain's start time
 * (an order modified mid-chain behind the cursor is picked up by the next
 * chain). A retried message redoes its whole slice, which is harmless.
 */
export async function syncSubscriptionsEtl(
  env: Env,
  options: SubscriptionsEtlOptions = {},
): Promise<SubscriptionsEtlResult> {
  const client = new BigCommerceClient(
    env.BIGCOMMERCE_STORE_HASH,
    env.BIGCOMMERCE_ACCESS_TOKEN,
  );
  const cursor =
    options.cursor ?? (await startSubscriptionsEtlChain(env, options.loadAll));

  const params: Record<string, string> = {};
  if (cursor.modifiedSince !== undefined) {
    params.min_date_modified = new Date(cursor.modifiedSince).toUTCString();
  }

  // BigCommerce doesn't document whether `min_id` is inclusive, so ask for
  // `afterId` itself and skip it below. Anything *below* it means the cursor
  // was ignored - carrying on would end the chain early and advance the
  // watermark past orders never seen.
  const orders = await client.listOrdersPage(cursor.afterId, params);
  if (orders.some((order) => order.id < cursor.afterId)) {
    console.error(
      `syncSubscriptionsEtl(): orders list ignored min_id=${cursor.afterId}; ending the chain WITHOUT advancing the watermark`,
    );
    return { ordersProcessed: 0 };
  }

  let ordersProcessed = 0;
  let afterId = cursor.afterId;
  let sliceFull = false;
  for (const order of orders) {
    if (order.id <= cursor.afterId) continue;
    if (ordersProcessed >= MAX_MEMBERSHIP_ORDERS_PER_MESSAGE) {
      sliceFull = true;
      break;
    }
    const products = await client.getOrderProducts(order.id);
    const membership = resolveMembership(products);
    if (membership) {
      await applyMembershipOrder(env, order, membership);
      ordersProcessed++;
    }
    afterId = order.id;
  }

  // A short page is the last one.
  if (!sliceFull && orders.length < ORDERS_PAGE_SIZE) {
    await setWatermark(env, SUBSCRIPTIONS_ETL_JOB_NAME, cursor.chainStartedAt);
    return { ordersProcessed };
  }

  const next = { ...cursor, afterId, messages: cursor.messages + 1 };
  if (next.messages >= MAX_CHAIN_MESSAGES) {
    console.error(
      `syncSubscriptionsEtl(): hit MAX_CHAIN_MESSAGES=${MAX_CHAIN_MESSAGES} safety cap at order id ${afterId}; ending the chain WITHOUT advancing the watermark`,
    );
    return { ordersProcessed };
  }
  return { ordersProcessed, next };
}

/**
 * Stub - see docs/bigcommerce-ingestion.md section 4 for the intended
 * design (page BigCommerce's `/v2/customers`, backfill identity fields for
 * existing `members` rows). Deferred: the identity fields it would
 * reconcile (`bigcommerce_id`, user linkage) belong to the Member Auth
 * `users`/`oauth_identities` schema (Phase 2.3), which hasn't landed yet -
 * there's nothing on today's `members` table for this to write that
 * `syncSubscriptionsEtl` doesn't already cover.
 */
export async function syncCustomersEtl(env: Env): Promise<void> {
  void env;
  console.info(
    "syncCustomersEtl(): not yet implemented - see docs/bigcommerce-ingestion.md section 4",
  );
}

/**
 * Stub - see docs/bigcommerce-ingestion.md section 4 for the intended
 * design (call MiniBC's recurring-subscription API and reconcile
 * `membership_tier`/`expiration_date` for members on a MiniBC plan).
 * Deferred: no MiniBC sandbox API key is available in this environment to
 * validate request/response shapes against.
 */
export async function syncMinibcSubscriptionsEtl(env: Env): Promise<void> {
  void env;
  console.info(
    "syncMinibcSubscriptionsEtl(): not yet implemented - see docs/bigcommerce-ingestion.md section 4",
  );
}
