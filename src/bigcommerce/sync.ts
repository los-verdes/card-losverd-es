import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";
import { notifyWalletsUpdated } from "../member/walletUpdates";
import { postSlackAlert } from "../slack/alert";
import { maybeEmailNewOrderCard } from "../email/newOrder";
import { bigCommerceOrderKey, recordMembershipOrder } from "./orders";

const BC_API_BASE = "https://api.bigcommerce.com/stores";

// Which SKUs are a membership. Everything else the store sells is ignored.
//
// An allow-list rather than a single hardcoded SKU, so a renamed or
// additional membership product is one line here. This is the same job the
// previous site's `BIGCOMMERCE_MEMBERSHIP_SKUS` did; Los Verdes sells one
// membership and draws no distinction between kinds of member, so there is
// nothing for a SKU to map *to*.
export const MEMBERSHIP_SKUS: ReadonlySet<string> = new Set(["LOSV-MEM-0001"]);

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
  /**
   * How many of this line item were bought. BigCommerce has always sent
   * this; it went unread until the one-membership-per-order invariant got a
   * check (#188). Optional because the store's own responses are the only
   * thing that fills it, and a response without it must not read as zero.
   */
  quantity?: number | string;
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

/**
 * The store refused this environment's credentials: a 401 or a 403 rather
 * than a transient failure.
 *
 * Its own type because the queue must treat it differently. Retrying a
 * refused token five times over thirteen minutes reaches the same answer
 * five times and then dead-letters, which announces itself in Slack as a
 * generic dead-letter -- a message that says nothing about the cause. On
 * staging's six-hourly resync that is four uninformative alerts a day for a
 * problem one specific alert would describe exactly. Same reasoning as an
 * order the store no longer has (#105): a fact about how things are set up
 * is not a thing to retry.
 */
export class BigCommerceAuthError extends Error {
  constructor(
    readonly status: number,
    readonly storeHash: string,
  ) {
    super(
      `BigCommerce refused this environment's credentials: HTTP ${status} for store ${storeHash}. ` +
        "The access token is missing, revoked, scoped too narrowly, or belongs to a different store.",
    );
    this.name = "BigCommerceAuthError";
  }
}

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

  // Callers interpolate ids into `path`, and a URL normalises `..` away
  // rather than rejecting it, so an id carrying dot segments would silently
  // address a different endpoint -- with this store's token attached. Ids are
  // encoded at every call site for that reason.
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
      // Before the ok/not-ok checks each caller makes, because every one of
      // them would otherwise turn a refused token into a generic failure and
      // hand it to the queue to retry.
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new BigCommerceAuthError(res.status, this.storeHash);
      }
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

  /**
   * The order, or `null` when BigCommerce reports it no longer exists.
   *
   * Distinguishing "gone" from "failed" matters: a 404 is a fact about the
   * store, not a transient error, and retrying it five times before
   * dead-lettering only delays the same answer (#105). v2 answers 204 for a
   * resource with no content, which for a single order means the same thing.
   */
  async getOrderIfPresent(
    orderId: number | string,
  ): Promise<BigCommerceOrder | null> {
    const res = await this.get(`orders/${encodeURIComponent(orderId)}`);
    if (res.status === 404 || res.status === 204) {
      await res.body?.cancel();
      return null;
    }
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
    const res = await this.get(`orders/${encodeURIComponent(orderId)}/products`);
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

/**
 * How many memberships an order actually contains, across every line item.
 *
 * The storefront is configured so this is always 1, and much of this system
 * assumes it: `membership_orders` is keyed on the order id, so an order has
 * one row and one membership to give. Counting it is what turns that from an
 * assumption into something we would notice being broken -- see the "One
 * order, one membership" section of docs/membership-card-provenance.md.
 *
 * Only line items whose SKU is a membership count. Everything else the store
 * sells is ignored here exactly as it is everywhere else.
 */
export function countMembershipUnits(
  products: BigCommerceOrderProduct[],
): number {
  let units = 0;
  for (const product of products) {
    if (!MEMBERSHIP_SKUS.has(product.sku)) continue;
    units += membershipLineItemQuantity(product);
  }
  return units;
}

/**
 * One membership line item's quantity, as a whole number of at least one.
 *
 * `quantity` is loosely typed because BigCommerce's v2 API has a history of
 * returning numeric fields as strings, so this has to cope with being handed
 * something other than a number.
 *
 * Anything present but unreadable is counted as one and logged, rather than
 * treated as a breach. That direction is deliberate. The "More than one
 * membership" report says somebody paid for a card that does not exist, and
 * every row on it should be a case where that demonstrably happened; filling
 * it with malformed responses would put ordinary-looking orders in front of
 * whoever reads it and teach them to disbelieve the whole list. A report
 * nobody trusts catches nothing, which costs more than the miss does -- and
 * the miss is not silent, because the anomaly is still in the logs.
 *
 * An absent quantity is taken as one without comment: it means we were not
 * told, rather than told something that makes no sense, and the field is
 * optional on our own side.
 */
function membershipLineItemQuantity(
  product: BigCommerceOrderProduct,
): number {
  const raw = product.quantity;
  if (raw === undefined) return 1;
  const quantity = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(quantity) || quantity < 1) {
    console.warn(
      `countMembershipUnits(): membership line item ${product.id} has an unreadable quantity ${JSON.stringify(raw)}, counting it as 1`,
    );
    return 1;
  }
  return quantity;
}

/** The order's first membership line item, if it has one. */
function resolveMembership(
  products: BigCommerceOrderProduct[],
): BigCommerceOrderProduct | null {
  return products.find((product) => MEMBERSHIP_SKUS.has(product.sku)) ?? null;
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
  /** `YYYY-MM-DD`; null when no order counts (e.g. every order was refunded). */
  expirationDate: string | null;
  memberSince: string | null;
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
 * - `expiration_date` is the latest counted order's expiry -- mirroring the
 *   Python app's "any membership still active" semantics. Whether that makes
 *   the membership active or expired is not stored: it depends on the day
 *   somebody asks (`effectiveStatus()` in src/member/artifacts.ts).
 * - The name comes from the latest counted order.
 *
 * ISO timestamps sort chronologically, so plain string comparison is correct.
 */
export function deriveMembershipState(
  orders: CountedMembershipOrder[],
): MembershipState {
  if (orders.length === 0) {
    return {
      expirationDate: null,
      memberSince: null,
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
    expirationDate,
    memberSince: earliest.created_on.slice(0, 10),
    firstName: latest.first_name || null,
    lastName: latest.last_name || null,
  };
}

/** Identity fields from the order being synced, used where the history doesn't say. */
export interface MemberFallback {
  firstName: string;
  lastName: string;
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
 * inserting a new row with a random id when no match exists. Never touches `auth_token` or `created_at` on an update -
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
    `SELECT member_id, first_name, last_name, expiration_date, member_since
     FROM members WHERE email = ?`,
  )
    .bind(email)
    .first<{
      member_id: string;
      first_name: string;
      last_name: string;
      expiration_date: string | null;
      member_since: string | null;
    }>();

  if (existing) {
    const firstName = state.firstName ?? existing.first_name;
    const lastName = state.lastName ?? existing.last_name;
    const unchanged =
      existing.first_name === firstName &&
      existing.last_name === lastName &&
      existing.expiration_date === state.expirationDate &&
      existing.member_since === state.memberSince;
    if (unchanged) {
      return { memberId: existing.member_id, passChanged: false };
    }
    await env.DB.prepare(
      `UPDATE members
       SET first_name = ?, last_name = ?, expiration_date = ?, member_since = ?, last_updated_at = ?
       WHERE member_id = ?`,
    )
      .bind(
        firstName,
        lastName,
        state.expirationDate,
        state.memberSince,
        now,
        existing.member_id,
      )
      .run();
    return { memberId: existing.member_id, passChanged: true };
  }

  if (state.expirationDate === null) return null;

  // Random rather than derived from BigCommerce: `member_id` is the pass
  // serial and the Google Wallet object id, and a customer id doesn't identify
  // one member (guest checkouts all have customer_id 0; a gifted order carries
  // the buyer's). Rows are always found by email, so it never needs to be
  // reproducible (#66).
  const memberId = `LV-${crypto.randomUUID()}`;
  const authToken = crypto.randomUUID();
  // ON CONFLICT(email) covers the gap between the SELECT above and this INSERT
  // (etl-sync's queue concurrency of 1 makes it rare, not impossible): the row
  // that got there first keeps its member_id and auth token, and takes this
  // state, which was derived from the same email's history.
  const inserted = await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       expiration_date = excluded.expiration_date,
       member_since = excluded.member_since,
       last_updated_at = excluded.last_updated_at
     RETURNING member_id`,
  )
    .bind(
      memberId,
      state.firstName ?? fallback.firstName,
      state.lastName ?? fallback.lastName,
      email,
      state.expirationDate,
      state.memberSince,
      authToken,
      now,
    )
    .first<{ member_id: string }>();
  // A brand-new member has no installed passes yet; this is only `true` so
  // the rare ON CONFLICT update above is never silently missed.
  return { memberId: inserted!.member_id, passChanged: true };
}

/**
 * Records the order in the `membership_orders` history, re-derives the
 * member's current state from that history, and pushes a pass update if the
 * pass changed. History goes first: it is idempotent, so if a later step
 * throws, the queue's retry simply rewrites the same row. The member updated
 * is the order's `member_email`, which can differ from its billing email.
 */
/**
 * Says so, once, when an order turns out to carry more than one membership.
 *
 * Deliberately not a failure: the order still confers the one membership it
 * is recorded as, and a line item never revokes anyone's membership by
 * itself -- the same call made for orders the store stops returning (#105).
 * What it costs is that somebody has paid for a membership no card exists
 * for, which is a thing for a person to put right, not for a sync to decide.
 *
 * Reads the stored count first so a resync does not repeat the alert every
 * time it revisits the order. That read only happens on the broken path; an
 * ordinary order adds no query.
 */
async function alertOnNewExtraMemberships(
  env: Env,
  orderId: number | string,
  units: number,
): Promise<boolean> {
  const previous = await env.DB.prepare(
    "SELECT membership_units FROM membership_orders WHERE order_id = ?",
  )
    .bind(bigCommerceOrderKey(orderId))
    .first<{ membership_units: number | null }>();
  const known = previous?.membership_units ?? null;
  if (known !== null && known > 1) return false;

  console.warn(
    `applyMembershipOrder(${bigCommerceOrderKey(orderId)}): order carries ${units} memberships, recording one`,
  );
  // No order id or address in the alert, for the same reason the missing-order
  // and dead-letter alerts carry none: a Slack channel has a wider audience
  // than our logs.
  await postSlackAlert(
    env,
    ':busts_in_silhouette: An order was placed with more than one membership on it. Only one of them is recorded, so somebody has paid for a card that does not exist. The admin reports list these under "More than one membership".',
  );
  return true;
}

async function applyMembershipOrder(
  env: Env,
  order: BigCommerceOrder,
  membership: BigCommerceOrderProduct,
  membershipUnits: number,
): Promise<string> {
  if (membershipUnits > 1) {
    await alertOnNewExtraMemberships(env, order.id, membershipUnits);
  }
  const memberEmail = await recordMembershipOrder(
    env,
    order,
    membership,
    membershipUnits,
  );
  const result = await refreshMemberFromOrders(env, memberEmail, {
    firstName: order.billing_address.first_name,
    lastName: order.billing_address.last_name,
  });
  if (result?.passChanged) {
    await notifyWalletsUpdated(env, result.memberId);
  }
  return memberEmail;
}

/**
 * Primary sync path: one BigCommerce order -> one `members` upsert.
 * Producer call site is the webhook route (`src/bigcommerce/routes.ts`),
 * via the `etl-sync` queue (`src/queues/etlSync.ts`).
 */
export type MissingOrderOutcome = "flagged" | "already-flagged" | "not-ours";

/**
 * Records that BigCommerce no longer returns an order we hold, and raises it
 * once for a person (los-verdes/card-losverd-es#105).
 *
 * What it deliberately does **not** do is stop the order counting. A deleted
 * order keeps conferring membership until someone looks at it and decides
 * otherwise (decided 2026-09-18). The alternative -- revoking a card because
 * one API call came back 404 -- would turn a BigCommerce incident into
 * members losing their cards en masse, and an order vanishing is rare enough
 * that a person can afford to look.
 *
 * Idempotent: only the first sighting sets the timestamp or alerts, so a
 * webhook that fires repeatedly for the same deleted order does not repeat
 * itself in Slack.
 */
export async function flagOrderMissingFromStore(
  env: Env,
  orderId: number | string,
): Promise<MissingOrderOutcome> {
  const key = bigCommerceOrderKey(orderId);
  const update = await env.DB.prepare(
    `UPDATE membership_orders
        SET missing_since = ?, updated_at = unixepoch('subsec') * 1000
      WHERE order_id = ? AND missing_since IS NULL`,
  )
    .bind(Date.now(), key)
    .run();

  if ((update.meta.changes ?? 0) === 0) {
    const existing = await env.DB.prepare(
      "SELECT 1 AS present FROM membership_orders WHERE order_id = ?",
    )
      .bind(key)
      .first<{ present: number }>();
    if (!existing) {
      // A webhook for an order we never held -- most often one with no
      // membership in it. Nothing was ever derived from it, so nothing to do.
      console.info(`flagOrderMissingFromStore(${key}): not an order we hold`);
      return "not-ours";
    }
    return "already-flagged";
  }

  console.warn(`flagOrderMissingFromStore(${key}): BigCommerce no longer returns this order`);
  // No order id or address in the alert, for the same reason the dead-letter
  // alert carries none: a Slack channel has a wider audience than our logs.
  await postSlackAlert(
    env,
    ":mag: A membership order is no longer in BigCommerce. It still counts towards its member's membership; see the admin reports' \"Missing from BigCommerce\" list to decide what should happen to it.",
  );
  return "flagged";
}

export async function syncBigCommerceOrder(
  env: Env,
  storeHash: string,
  orderId: number | string,
): Promise<void> {
  const client = new BigCommerceClient(storeHash, env.BIGCOMMERCE_ACCESS_TOKEN);
  // Fetched before the line items rather than alongside them: if the order is
  // gone, its products are gone too, and asking would only turn one clear
  // answer into a second failure.
  const order = await client.getOrderIfPresent(orderId);
  if (!order) {
    await flagOrderMissingFromStore(env, orderId);
    return;
  }
  const products = await client.getOrderProducts(orderId);

  const membership = resolveMembership(products);
  if (!membership) {
    console.info(
      `syncBigCommerceOrder(${orderId}): no membership SKU found in order line items, skipping`,
    );
    return;
  }

  const memberEmail = await applyMembershipOrder(
    env,
    order,
    membership,
    countMembershipUnits(products),
  );
  // Webhook path only -- the resyncs call applyMembershipOrder directly
  // (src/email/newOrder.ts).
  await maybeEmailNewOrderCard(env, order, memberEmail);
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
      await applyMembershipOrder(
        env,
        order,
        membership,
        countMembershipUnits(products),
      );
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
 * `expiration_date` for members on a MiniBC plan).
 * Deferred: no MiniBC sandbox API key is available in this environment to
 * validate request/response shapes against.
 */
export async function syncMinibcSubscriptionsEtl(env: Env): Promise<void> {
  void env;
  console.info(
    "syncMinibcSubscriptionsEtl(): not yet implemented - see docs/bigcommerce-ingestion.md section 4",
  );
}
