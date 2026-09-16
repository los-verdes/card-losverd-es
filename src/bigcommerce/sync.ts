import type { Env } from "../index";

const BC_API_BASE = "https://api.bigcommerce.com/stores";

// Membership lasts one year from the order's creation date, mirroring
// `AnnualMembership.expiry_date` (`created_on + timedelta(days=365)`) in
// the Python app's `member_card/models/annual_membership.py`.
const MEMBERSHIP_DURATION_DAYS = 365;

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
}

export interface BigCommerceOrderProduct {
  id: number;
  product_id: number;
  sku: string;
  name: string;
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

  private url(path: string, query?: URLSearchParams): string {
    const base = `${BC_API_BASE}/${this.storeHash}/v2/${path}`;
    return query ? `${base}?${query.toString()}` : base;
  }

  async getOrder(orderId: number | string): Promise<BigCommerceOrder> {
    const res = await fetch(this.url(`orders/${orderId}`), {
      headers: bcHeaders(this.accessToken),
    });
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
    const res = await fetch(this.url(`orders/${orderId}/products`), {
      headers: bcHeaders(this.accessToken),
    });
    if (res.status === 204) return [];
    if (!res.ok) {
      throw new Error(
        `BigCommerce getOrderProducts(${orderId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }

  /** One page of the v2 orders list, optionally filtered (e.g. `min_date_modified`). */
  async listOrdersPage(
    page: number,
    params: Record<string, string> = {},
  ): Promise<BigCommerceOrder[]> {
    const query = new URLSearchParams({
      page: String(page),
      limit: "50",
      ...params,
    });
    const res = await fetch(this.url("orders", query), {
      headers: bcHeaders(this.accessToken),
    });
    // BigCommerce's v2 API returns 204 (not an empty array) once a page is past the end of results.
    if (res.status === 204) return [];
    if (!res.ok) {
      throw new Error(
        `BigCommerce listOrders(page=${page}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }
}

function resolveMembershipTier(
  products: BigCommerceOrderProduct[],
): string | null {
  for (const product of products) {
    const tier = MEMBERSHIP_SKU_TIER_MAP[product.sku];
    if (tier) return tier;
  }
  return null;
}

function computeExpirationDate(dateCreated: string): string {
  const created = new Date(dateCreated);
  const expiry = new Date(
    created.getTime() + MEMBERSHIP_DURATION_DAYS * 24 * 60 * 60 * 1000,
  );
  return expiry.toISOString().slice(0, 10); // YYYY-MM-DD, matches the schema's ISO8601-date convention
}

function computeStatus(
  expirationDate: string,
  now: Date,
): "active" | "expired" {
  return expirationDate >= now.toISOString().slice(0, 10)
    ? "active"
    : "expired";
}

export interface MemberUpsertInput {
  customerId: number;
  firstName: string;
  lastName: string;
  email: string;
  membershipTier: string;
  /** `YYYY-MM-DD` of the membership order's creation - a `member_since` candidate. */
  orderDate: string;
  expirationDate: string;
}

interface ExistingMembershipState {
  expiration_date: string | null;
  member_since: string | null;
}

interface MergedMembershipState {
  status: "active" | "expired";
  expirationDate: string;
  memberSince: string;
}

/**
 * Merges one order's membership dates into whatever a `members` row
 * already holds, such that syncing orders in *any* sequence converges on
 * the same result (webhooks and the scheduled resync don't deliver orders
 * chronologically - e.g. an old order's status change re-fires its
 * webhook long after a renewal has synced):
 *
 * - `member_since` only ever moves earlier. This is also what protects the
 *   one-time Squarespace-era backfill (plan Phase 2.2) from being clobbered
 *   by a later BigCommerce order.
 * - `expiration_date` only ever moves later - an older order must not roll
 *   back a renewal. `status` is then derived from the merged expiration,
 *   mirroring the Python app's "any membership still active" semantics.
 *
 * ISO `YYYY-MM-DD` strings sort chronologically, so plain string
 * comparison is correct here.
 */
export function mergeMembershipState(
  existing: ExistingMembershipState | null,
  input: Pick<MemberUpsertInput, "orderDate" | "expirationDate">,
  now: Date = new Date(),
): MergedMembershipState {
  const memberSince =
    existing?.member_since && existing.member_since < input.orderDate
      ? existing.member_since
      : input.orderDate;
  const expirationDate =
    existing?.expiration_date && existing.expiration_date > input.expirationDate
      ? existing.expiration_date
      : input.expirationDate;
  return {
    status: computeStatus(expirationDate, now),
    expirationDate,
    memberSince,
  };
}

/**
 * Idempotent upsert into `members` (see docs/bigcommerce-ingestion.md
 * section 2 for the full column-by-column mapping rationale).
 *
 * Matches by `email` first (the natural join key with any member row that
 * predates this sync, whose `member_id` must be preserved). Falls back to inserting a new row
 * keyed by a deterministic `BC-{customerId}` id when no match exists. Never
 * touches `auth_token` or `created_at` on an update - those represent
 * Apple/Google Wallet pass state that only this table's *sync* code should
 * never regenerate.
 */
export async function upsertMemberFromOrder(
  env: Env,
  input: MemberUpsertInput,
): Promise<void> {
  const email = input.email.toLowerCase();
  const now = Date.now();

  const existing = await env.DB.prepare(
    "SELECT member_id, expiration_date, member_since FROM members WHERE email = ?",
  )
    .bind(email)
    .first<{ member_id: string } & ExistingMembershipState>();

  const merged = mergeMembershipState(existing, input);

  if (existing) {
    await env.DB.prepare(
      `UPDATE members
       SET first_name = ?, last_name = ?, membership_tier = ?, status = ?, expiration_date = ?, member_since = ?, last_updated_at = ?
       WHERE member_id = ?`,
    )
      .bind(
        input.firstName,
        input.lastName,
        input.membershipTier,
        merged.status,
        merged.expirationDate,
        merged.memberSince,
        now,
        existing.member_id,
      )
      .run();
    return;
  }

  const memberId = `BC-${input.customerId}`;
  const authToken = crypto.randomUUID();
  // ON CONFLICT is a safety net for the TOCTOU gap between the SELECT above
  // and this INSERT (e.g. two overlapping syncs for the same customer) -
  // etl-sync's queue concurrency is capped at 1 (Phase 2.5.1) specifically
  // to make that rare, not to make it impossible. The date columns repeat
  // mergeMembershipState()'s never-regress rules in SQL, since the
  // conflicting row wasn't visible when `merged` was computed. (SQLite's
  // multi-argument MIN()/MAX() return NULL if any argument is NULL, hence
  // the COALESCEs.)
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       email = excluded.email,
       membership_tier = excluded.membership_tier,
       expiration_date = MAX(COALESCE(members.expiration_date, excluded.expiration_date), excluded.expiration_date),
       status = CASE
         WHEN MAX(COALESCE(members.expiration_date, excluded.expiration_date), excluded.expiration_date) >= ?
           THEN 'active'
         ELSE 'expired'
       END,
       member_since = MIN(COALESCE(members.member_since, excluded.member_since), excluded.member_since),
       last_updated_at = excluded.last_updated_at`,
  )
    .bind(
      memberId,
      input.firstName,
      input.lastName,
      email,
      input.membershipTier,
      merged.status,
      merged.expirationDate,
      merged.memberSince,
      authToken,
      now,
      new Date(now).toISOString().slice(0, 10),
    )
    .run();
}

function upsertInputFromOrder(
  order: BigCommerceOrder,
  membershipTier: string,
): MemberUpsertInput {
  return {
    customerId: order.customer_id,
    firstName: order.billing_address.first_name,
    lastName: order.billing_address.last_name,
    email: order.billing_address.email,
    membershipTier,
    orderDate: new Date(order.date_created).toISOString().slice(0, 10),
    expirationDate: computeExpirationDate(order.date_created),
  };
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

  const membershipTier = resolveMembershipTier(products);
  if (!membershipTier) {
    console.info(
      `syncBigCommerceOrder(${orderId}): no membership SKU found in order line items, skipping`,
    );
    return;
  }

  await upsertMemberFromOrder(env, upsertInputFromOrder(order, membershipTier));
}

const SUBSCRIPTIONS_ETL_JOB_NAME = "sync_subscriptions_etl";
// Mirrors `bigcommerce_orders_etl`'s "last run time minus 12 hours" overlap
// window in `member_card/bigcommerce.py`, so an order modified right at the
// edge of the previous run's window is never silently missed.
const DEFAULT_LOOKBACK_HOURS = 12;
// Safety cap on page count for a first pass - BigCommerce's v2 orders list
// has no explicit "last page" indicator besides an eventual 204/empty page.
const MAX_PAGES = 50;

async function getWatermark(env: Env, jobName: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT last_run_at FROM etl_sync_state WHERE job_name = ?",
  )
    .bind(jobName)
    .first<{ last_run_at: number }>();
  return row?.last_run_at ?? null;
}

async function setWatermark(
  env: Env,
  jobName: string,
  timestamp: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
  )
    .bind(jobName, timestamp, timestamp)
    .run();
}

export interface SubscriptionsEtlOptions {
  /** Skip the modified-since filter entirely - a full historical resync (Phase 2.2's initial cache population). */
  loadAll?: boolean;
}

export interface SubscriptionsEtlResult {
  ordersProcessed: number;
}

/**
 * Scheduled full/incremental resync (Phase 2.5.3's `sync_subscriptions_etl`
 * cron message) - the one fully-implemented example of the three scheduled
 * ETL jobs named in Phase 2.5.3 (see docs/bigcommerce-ingestion.md section
 * 4 for why this one and not the other two). Pages through BigCommerce's
 * v2 orders list, filtered to orders modified since the last successful
 * run (minus a trailing overlap window), and runs every returned order
 * through the same idempotent `upsertMemberFromOrder` path as the webhook
 * flow - repeated runs converge, they don't duplicate.
 */
export async function syncSubscriptionsEtl(
  env: Env,
  options: SubscriptionsEtlOptions = {},
): Promise<SubscriptionsEtlResult> {
  const client = new BigCommerceClient(
    env.BIGCOMMERCE_STORE_HASH,
    env.BIGCOMMERCE_ACCESS_TOKEN,
  );
  const runStart = Date.now();

  const params: Record<string, string> = {};
  if (!options.loadAll) {
    const watermark = await getWatermark(env, SUBSCRIPTIONS_ETL_JOB_NAME);
    const since =
      watermark ?? runStart - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000;
    const overlapSince = since - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000;
    params.min_date_modified = new Date(overlapSince).toUTCString();
  }

  let page = 1;
  let ordersProcessed = 0;
  for (;;) {
    if (page > MAX_PAGES) {
      console.warn(
        `syncSubscriptionsEtl(): hit MAX_PAGES=${MAX_PAGES} safety cap, stopping early`,
      );
      break;
    }
    const orders = await client.listOrdersPage(page, params);
    if (orders.length === 0) break;

    for (const order of orders) {
      const products = await client.getOrderProducts(order.id);
      const membershipTier = resolveMembershipTier(products);
      if (!membershipTier) continue;
      await upsertMemberFromOrder(
        env,
        upsertInputFromOrder(order, membershipTier),
      );
      ordersProcessed++;
    }
    page++;
  }

  await setWatermark(env, SUBSCRIPTIONS_ETL_JOB_NAME, runStart);
  return { ordersProcessed };
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
