/**
 * MiniBC's membership subscriptions, the store's automatic renewals (#397).
 *
 * A renewal MiniBC charges creates a BigCommerce order, which the order sync
 * already counts, so nothing here decides who is a member. What only MiniBC
 * knows is whether a membership renews at all, when it next does, and
 * whether it was paused or cancelled; this reads that twice a day into
 * `minibc_subscriptions` for admins to see. It never changes a card, and it
 * never emails anyone.
 *
 * What MiniBC's API returned when this was written (checked 2026-09-30):
 *
 * - `POST /subscriptions/search` with `product_sku` pages 50 at a time, in id
 *   order, and answers 404 past the last page.
 * - Each subscription carries `next_payment_date` without asking for it, the
 *   order that started it (`order_id`), and `customer.store_customer_id` and
 *   `customer.email`. The email is kept only to hint at the member for a
 *   subscription no order matches (#470); it never matches anything.
 * - Dates are `YYYY-MM-DD`, an empty string when there is none, and at least
 *   once PHP's zero date (`-0001-11-30`); `last_modified` is epoch seconds.
 * - `periodicity` says one month on every subscription, while both membership
 *   products are set to twelve, and next payments fall on signup
 *   anniversaries. It is not kept.
 *
 * The API key can also cancel subscriptions, edit them, and charge or refund
 * saved cards. `MinibcClient` can only search, and has no other request in
 * it; keep it that way.
 */

import type { Env } from "../index";
import { MEMBERSHIP_SKUS } from "../bigcommerce/sync";

export const MINIBC_API_BASE = "https://apps.minibc.com/api/apps/recurring/v1";
export const MINIBC_JOB_NAME = "sync_minibc_subscriptions_etl";
/** Pages read per queue message, 50 subscriptions each; the store has ~24 pages, so a read is three messages. */
export const MINIBC_PAGES_PER_MESSAGE = 10;
/** A backstop against an API that stops answering 404 past the end: no SKU has anywhere near this many pages. */
export const MINIBC_MAX_PAGES_PER_SKU = 200;
/** A pause between pages, as the previous site's client made; MiniBC publishes no rate limit. */
const PAGE_PAUSE_MS = 250;
const MAX_ATTEMPTS = 4;

/** The parts of a MiniBC subscription this keeps. Everything else it returns is ignored. */
export interface MinibcSubscription {
  id: number;
  order_id?: number | null;
  status?: string;
  signup_date?: string;
  next_payment_date?: string;
  pause_date?: string;
  cancellation_date?: string;
  last_modified?: string | number;
  customer?: { store_customer_id?: number | string | null; email?: string | null };
  metadata?: { origin_order_id?: number | string | null } | unknown[] | null;
}

/** MiniBC refused the key: a configuration problem, not something to retry. */
export class MinibcAuthError extends Error {
  constructor(readonly status: number) {
    super(`MiniBC refused the API key (${status})`);
  }
}

/** Search only: see the note at the top of this file. */
export class MinibcClient {
  constructor(
    private readonly apiKey: string,
    private readonly retryDelayMs = 500,
  ) {}

  /** One page of the subscriptions to a product, or null past the last page. */
  async searchSubscriptions(sku: string, page: number): Promise<MinibcSubscription[] | null> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${MINIBC_API_BASE}/subscriptions/search`, {
        method: "POST",
        headers: { "X-MBC-TOKEN": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ product_sku: sku, page }),
      });
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new MinibcAuthError(res.status);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await res.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw new Error(`MiniBC subscriptions/search (${sku}, page ${page}) failed: ${res.status} ${await res.text()}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error(`MiniBC subscriptions/search (${sku}, page ${page}) returned something other than a list`);
      return body.length > 0 ? (body as MinibcSubscription[]) : null;
    }
  }
}

/** A MiniBC date as `YYYY-MM-DD`, or null for its empty forms: "", "0", zeros, PHP's `-0001-11-30`. */
export function minibcDate(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim()) : null;
  if (!match || Number(match[1]) < 1970 || match[2] === "00" || match[3] === "00") return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** MiniBC's epoch-seconds timestamp in epoch ms, or null for none. */
export function minibcTimestamp(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** MiniBC's customer email, trimmed and lowercased as every address here is, or null for none. */
function customerEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.includes("@") ? email : null;
}

/** A subscription as a `minibc_subscriptions` row, less the columns the walk sets. */
export function subscriptionRow(subscription: MinibcSubscription) {
  const metadata = subscription.metadata && !Array.isArray(subscription.metadata) ? subscription.metadata : null;
  return {
    subscription_id: positiveInteger(subscription.id),
    order_id: positiveInteger(subscription.order_id),
    origin_order_id: positiveInteger(metadata?.origin_order_id),
    store_customer_id: positiveInteger(subscription.customer?.store_customer_id),
    customer_email: customerEmail(subscription.customer?.email),
    status: typeof subscription.status === "string" && subscription.status ? subscription.status : "unknown",
    signup_on: minibcDate(subscription.signup_date),
    next_payment_on: minibcDate(subscription.next_payment_date),
    paused_on: minibcDate(subscription.pause_date),
    cancelled_on: minibcDate(subscription.cancellation_date),
    minibc_modified_at: minibcTimestamp(subscription.last_modified),
  };
}

/** Continuation state from one message of a read to the next. */
export interface MinibcCursor {
  /** When the read's first message started (epoch ms): every subscription it lists is stamped with it. */
  walkStartedAt: number;
  /** Which of `MEMBERSHIP_SKUS` it is on. */
  skuIndex: number;
  /** The next page of that SKU to read. */
  page: number;
}

export interface MinibcSyncResult {
  /** Subscriptions this message read. */
  read: number;
  /** Set when the read isn't finished: enqueue a follow-up carrying it. */
  next?: MinibcCursor;
}

/** One page, written in a single statement. */
async function recordPage(env: Env, sku: string, subscriptions: MinibcSubscription[], seenAt: number): Promise<void> {
  const rows = subscriptions.map(subscriptionRow).filter((row) => row.subscription_id !== null);
  if (rows.length === 0) return;
  await env.DB.prepare(
    `INSERT INTO minibc_subscriptions (
       subscription_id, order_id, origin_order_id, store_customer_id, customer_email, sku, status,
       signup_on, next_payment_on, paused_on, cancelled_on, minibc_modified_at, seen_at, missing_since, updated_at
     )
     SELECT json_extract(value, '$.subscription_id'), json_extract(value, '$.order_id'),
            json_extract(value, '$.origin_order_id'), json_extract(value, '$.store_customer_id'),
            json_extract(value, '$.customer_email'),
            ?2, json_extract(value, '$.status'), json_extract(value, '$.signup_on'),
            json_extract(value, '$.next_payment_on'), json_extract(value, '$.paused_on'),
            json_extract(value, '$.cancelled_on'), json_extract(value, '$.minibc_modified_at'),
            ?3, NULL, unixepoch('subsec') * 1000
     FROM json_each(?1) WHERE true
     ON CONFLICT(subscription_id) DO UPDATE SET
       order_id = excluded.order_id,
       origin_order_id = excluded.origin_order_id,
       store_customer_id = excluded.store_customer_id,
       customer_email = excluded.customer_email,
       sku = excluded.sku,
       status = excluded.status,
       signup_on = excluded.signup_on,
       next_payment_on = excluded.next_payment_on,
       paused_on = excluded.paused_on,
       cancelled_on = excluded.cancelled_on,
       minibc_modified_at = excluded.minibc_modified_at,
       seen_at = excluded.seen_at,
       missing_since = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(rows), sku, seenAt)
    .run();
}

/** After a complete read: flags what it no longer listed, and records that the job ran. */
async function finishRead(env: Env, walkStartedAt: number): Promise<number> {
  const now = Date.now();
  const flagged = await env.DB.prepare(
    "UPDATE minibc_subscriptions SET missing_since = ?, updated_at = ? WHERE seen_at < ? AND missing_since IS NULL",
  )
    .bind(now, now, walkStartedAt)
    .run();
  await env.DB.prepare(
    `INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
  )
    .bind(MINIBC_JOB_NAME, walkStartedAt, now)
    .run();
  return flagged.meta.changes ?? 0;
}

/**
 * Reads every membership subscription from MiniBC, `MINIBC_PAGES_PER_MESSAGE`
 * pages per call; returns `next` for the caller to enqueue until the read is
 * complete. A read always covers everything: there are about 1,200, and
 * MiniBC offers no "modified since" filter.
 */
export async function syncMinibcSubscriptions(env: Env, cursor?: MinibcCursor, pauseMs = PAGE_PAUSE_MS): Promise<MinibcSyncResult> {
  if (!env.MINIBC_API_KEY) {
    console.info("syncMinibcSubscriptions(): MINIBC_API_KEY unset in this environment; nothing read");
    return { read: 0 };
  }
  const client = new MinibcClient(env.MINIBC_API_KEY);
  const skus = [...MEMBERSHIP_SKUS];
  let at: MinibcCursor = cursor ?? { walkStartedAt: Date.now(), skuIndex: 0, page: 1 };
  let read = 0;
  for (let pages = 0; at.skuIndex < skus.length; ) {
    if (pages >= MINIBC_PAGES_PER_MESSAGE) return { read, next: at };
    if (at.page > MINIBC_MAX_PAGES_PER_SKU) {
      throw new Error(`syncMinibcSubscriptions(): more than ${MINIBC_MAX_PAGES_PER_SKU} pages for ${skus[at.skuIndex]}; is MiniBC still paging?`);
    }
    if (pages > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const sku = skus[at.skuIndex];
    const page = await client.searchSubscriptions(sku, at.page);
    pages++;
    if (!page) {
      at = { ...at, skuIndex: at.skuIndex + 1, page: 1 };
      continue;
    }
    await recordPage(env, sku, page, at.walkStartedAt);
    read += page.length;
    at = { ...at, page: at.page + 1 };
  }
  const flagged = await finishRead(env, at.walkStartedAt);
  console.info(`syncMinibcSubscriptions(): read complete; ${read} in this message, ${flagged} no longer listed`);
  return { read };
}
