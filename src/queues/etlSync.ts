import type { Env } from "../index";
import {
  syncBigCommerceOrder,
  syncCustomersEtl,
  syncMinibcSubscriptionsEtl,
  syncSubscriptionsEtl,
} from "../bigcommerce/sync";

/**
 * `etl-sync` queue message schema, per the migration plan's Phase 2.5.4.
 * Kept in its own module so both the BigCommerce
 * webhook route (producer) and this queue's consumer/scheduled trigger
 * (Phase 2.5.3) share one definition.
 */
export type EtlSyncMessage =
  | { type: "sync_bigcommerce_order"; orderId: string; storeHash: string }
  | { type: "sync_subscriptions_etl"; loadAll?: boolean }
  | { type: "sync_customers_etl" }
  | { type: "sync_minibc_subscriptions_etl" }
  | { type: "run_slack_members_etl" };

/**
 * Enqueue a message onto the `etl-sync` queue.
 *
 * TODO(Phase 2.5.2): `wrangler.toml` doesn't declare the `etl-sync` queue
 * or its `ETL_SYNC_QUEUE` producer binding yet, and no such queue exists in
 * the Cloudflare account behind this Worker. Until that config lands, this
 * function logs and no-ops instead of throwing, so callers (the webhook
 * route, the scheduled handler) can be written and tested against the real
 * `env.ETL_SYNC_QUEUE.send()` call site today. Once the binding exists,
 * this starts actually enqueueing with no call-site changes required.
 */
export async function enqueueEtlSync(
  env: Env,
  message: EtlSyncMessage,
): Promise<void> {
  if (!env.ETL_SYNC_QUEUE) {
    console.warn(
      "enqueueEtlSync(): ETL_SYNC_QUEUE binding is not configured yet (see docs/bigcommerce-ingestion.md section 3/5) - dropping message",
      message,
    );
    return;
  }
  await env.ETL_SYNC_QUEUE.send(message);
}

async function dispatchEtlSyncMessage(
  message: EtlSyncMessage,
  env: Env,
): Promise<void> {
  switch (message.type) {
    case "sync_bigcommerce_order":
      await syncBigCommerceOrder(env, message.storeHash, message.orderId);
      return;
    case "sync_subscriptions_etl":
      await syncSubscriptionsEtl(env, { loadAll: message.loadAll });
      return;
    case "sync_customers_etl":
      await syncCustomersEtl(env);
      return;
    case "sync_minibc_subscriptions_etl":
      await syncMinibcSubscriptionsEtl(env);
      return;
    case "run_slack_members_etl":
      // Slack member ETL is Slack-integration scope, not BigCommerce
      // ingestion - out of scope for this design pass.
      console.warn(
        "run_slack_members_etl is out of scope for BigCommerce ingestion; no-op",
      );
      return;
  }
}

/**
 * `etl-sync` queue consumer. Not wired into `src/index.ts`'s default
 * export's `queue()` handler dispatch table yet since there's no queue to
 * trigger it (see TODO on `enqueueEtlSync` above) - left ready for when
 * Phase 2.5.2's `[[queues.consumers]]` config lands.
 *
 * Handles ack/retry per-message (not letting one failure fail the whole
 * batch), per Phase 2.5.2's `etl-sync` consumer, whose concurrency is
 * capped at 1 so this and a webhook-triggered sync never race each other's
 * D1 writes.
 */
export async function handleEtlSyncBatch(
  batch: MessageBatch<EtlSyncMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await dispatchEtlSyncMessage(message.body, env);
      message.ack();
    } catch (err) {
      console.error("etl-sync handler failed", {
        type: message.body.type,
        attempts: message.attempts,
        err,
      });
      message.retry({
        delaySeconds: Math.min(300, 15 * 2 ** message.attempts),
      });
    }
  }
}
