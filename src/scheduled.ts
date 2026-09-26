import type { Env } from "./index";
import { enqueueEtlSync, type EtlSyncMessage } from "./queues/etlSync";

/**
 * Cron string -> etl-sync message, per the migration plan's Phase 2.5.3.
 * Exactly the crons in `[triggers].crons` in `wrangler.toml`, for both
 * environments; a test holds the three together, so a job cannot be mapped
 * here and never scheduled, or scheduled and never mapped.
 *
 * `sync_customers_etl` and `sync_minibc_subscriptions_etl` are stubs
 * (src/bigcommerce/sync.ts) and are not scheduled.
 */
export const CRON_TO_MESSAGE: Record<string, EtlSyncMessage> = {
  "0 */6 * * *": { type: "run_slack_members_etl" },
  // Incremental: orders modified since the last run, less an overlap window.
  "15 */6 * * *": { type: "sync_subscriptions_etl" },
  // Weekly, early Sunday UTC: every order in the store, as a backstop
  // against drift the incremental runs cannot see (#347). It reports what it
  // changed and re-reads anything the store's list no longer returns.
  "45 4 * * 0": { type: "sync_subscriptions_etl", loadAll: true },
  // Weekly rather than daily: the slowest thing it watches is the Apple pass
  // certificate, which warns thirty days out, so a week's granularity still
  // leaves four warnings before it lapses. It posts only when something has
  // actually failed (src/admin/readinessAlert.ts).
  "0 9 * * 1": { type: "run_readiness_check" },
  // Daily, just after midnight UTC: a membership ends at 23:59:59 UTC on its
  // expiry date, so by now yesterday's lapses are final (#295).
  "30 0 * * *": { type: "run_pass_expiry_sweep" },
  // Hourly, on the tens so it does not share a minute with the others: looks
  // for operational trouble and says so once (#56, src/ops/watch.ts).
  "10 * * * *": { type: "run_ops_watch" },
};

/**
 * Enqueues rather than running the ETL inline, for the same reason
 * webhook-triggered syncs are queued: a transient BigCommerce/Slack API
 * failure then gets `etl-sync`'s retry + DLQ handling for free, instead of
 * the cron invocation simply failing with no retry.
 */
export async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const message = CRON_TO_MESSAGE[event.cron];
  if (!message) {
    console.warn(
      `scheduled(): no etl-sync message mapped for cron="${event.cron}"`,
    );
    return;
  }
  ctx.waitUntil(enqueueEtlSync(env, message));
}
