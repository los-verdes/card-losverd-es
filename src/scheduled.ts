import type { Env } from "./index";
import { enqueueEtlSync, type EtlSyncMessage } from "./queues/etlSync";

/**
 * Cron string -> etl-sync message, per the migration plan's Phase 2.5.3.
 * Keep this in sync with `[triggers].crons` once that block is added to
 * `wrangler.toml` -- held back until real BigCommerce credentials are set,
 * since these jobs would otherwise fail against placeholder secrets.
 */
const CRON_TO_MESSAGE: Record<string, EtlSyncMessage> = {
  "0 */6 * * *": { type: "run_slack_members_etl" },
  "15 */6 * * *": { type: "sync_subscriptions_etl" },
  "30 * * * *": { type: "sync_customers_etl" },
  "30 */12 * * *": { type: "sync_minibc_subscriptions_etl" },
  // Weekly rather than daily: the slowest thing it watches is the Apple pass
  // certificate, which warns thirty days out, so a week's granularity still
  // leaves four warnings before it lapses. It posts only when something has
  // actually failed (src/admin/readinessAlert.ts).
  "0 9 * * 1": { type: "run_readiness_check" },
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
