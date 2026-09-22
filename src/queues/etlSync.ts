import type { Env } from "../index";
import { postSlackAlert } from "../slack/alert";
import {
  BigCommerceAuthError,
  syncBigCommerceOrder,
  syncCustomersEtl,
  syncMinibcSubscriptionsEtl,
  syncSubscriptionsEtl,
  type SubscriptionsEtlCursor,
} from "../bigcommerce/sync";
import { runReadinessCheck } from "../admin/readinessAlert";
import { refreshLapsedPasses, runPassExpirySweep } from "../member/passExpirySweep";
import { runOpsWatch } from "../ops/watch";
import { runSlackMembersEtl } from "../slack/membersEtl";

/**
 * `etl-sync` queue message schema, per the migration plan's Phase 2.5.4.
 * Kept in its own module so both the BigCommerce
 * webhook route (producer) and this queue's consumer/scheduled trigger
 * (Phase 2.5.3) share one definition.
 */
export type EtlSyncMessage =
  | { type: "sync_bigcommerce_order"; orderId: string; storeHash: string }
  | {
      type: "sync_subscriptions_etl";
      loadAll?: boolean;
      /** Set only on a resync chain's follow-up messages; without it, a new chain starts. */
      cursor?: SubscriptionsEtlCursor;
    }
  | { type: "sync_customers_etl" }
  | { type: "sync_minibc_subscriptions_etl" }
  | { type: "run_slack_members_etl" }
  | { type: "run_readiness_check" }
  | { type: "run_pass_expiry_sweep" }
  | { type: "run_ops_watch" }
  /** One batch of the one-off refresh; `afterMemberId` is set on follow-ups. */
  | { type: "refresh_lapsed_passes"; afterMemberId?: string }
  /**
   * Fails on purpose, so the dead-letter path can be exercised in a real
   * environment (`scripts/queue-dlq-drill.mjs`). Nothing produces it but that
   * script, and it is named rather than relying on an unrecognised type so
   * that the drill does not quietly depend on what `default:` happens to do
   * -- and so a `dlq_drill` in the logs or in Slack is obviously a drill
   * rather than something to investigate at two in the morning.
   */
  | { type: "dlq_drill"; sentAt?: string };

/** Enqueue a message onto the `etl-sync` queue (the single typed send site). */
export async function enqueueEtlSync(
  env: Env,
  message: EtlSyncMessage,
): Promise<void> {
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
    case "sync_subscriptions_etl": {
      const { next } = await syncSubscriptionsEtl(env, {
        loadAll: message.loadAll,
        cursor: message.cursor,
      });
      // Only once the slice has succeeded: a failed slice is retried as a
      // whole instead of the chain moving past it.
      if (next) {
        await enqueueEtlSync(env, {
          type: "sync_subscriptions_etl",
          loadAll: message.loadAll,
          cursor: next,
        });
      }
      return;
    }
    case "sync_customers_etl":
      await syncCustomersEtl(env);
      return;
    case "sync_minibc_subscriptions_etl":
      await syncMinibcSubscriptionsEtl(env);
      return;
    case "run_slack_members_etl":
      await runSlackMembersEtl(env);
      return;
    case "run_readiness_check":
      await runReadinessCheck(env);
      return;
    case "run_pass_expiry_sweep":
      await runPassExpirySweep(env);
      return;
    case "run_ops_watch":
      await runOpsWatch(env);
      return;
    case "refresh_lapsed_passes": {
      const next = await refreshLapsedPasses(env, message.afterMemberId);
      // Only once the batch has succeeded, as with the resync chain.
      if (next) await enqueueEtlSync(env, { type: "refresh_lapsed_passes", afterMemberId: next });
      return;
    }
    case "dlq_drill":
      // The one message whose failure is the point. Throwing takes it
      // through exactly what a real failure takes: the retries, the
      // dead-letter queue, and the alert that consumer posts.
      throw new Error(
        `etl-sync: dlq_drill is a deliberate failure${message.sentAt ? `, sent ${message.sentAt}` : ""} (scripts/queue-dlq-drill.mjs)`,
      );
    default: {
      // The same reasoning `handleQueueBatch` applies one file over, for the
      // same reason: acking a message nothing understands throws the work
      // away silently. Throwing retries it and, failing that, dead-letters
      // it -- which since #28's alerting says so in Slack.
      //
      // The realistic way to get here is a deploy ordering: a producer
      // shipping a new message type before the consumer that handles it, or
      // a rollback past one. Those are recoverable if the message survives,
      // and not if it doesn't.
      const unhandled: never = message;
      const type = (unhandled as { type?: unknown }).type;
      throw new Error(`etl-sync: no handler for message type ${JSON.stringify(type)}`);
    }
  }
}

/**
 * `etl-sync` queue consumer, routed from `src/queues/index.ts`.
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
      if (err instanceof BigCommerceAuthError) {
        // Not retried, and not dead-lettered. Five more attempts get the same
        // refusal, and the dead-letter alert that follows names the queue
        // rather than the cause. Acking with an alert that says what is
        // actually wrong is more use than thirteen minutes of backoff.
        console.error("etl-sync handler stopped: BigCommerce credentials refused", {
          type: message.body.type,
          status: err.status,
          error: err.message,
        });
        // No store hash or token detail: a Slack channel has a wider audience
        // than our logs, the same reason the other alerts here carry none.
        await postSlackAlert(
          env,
          ":closed_lock_with_key: BigCommerce refused this environment's credentials, so order syncing has stopped. The access token needs checking -- it may be revoked, too narrowly scoped, or pointed at the wrong store. /admin/preflight checks it directly.",
        );
        message.ack();
        continue;
      }
      console.error("etl-sync handler failed", {
        type: message.body.type,
        attempts: message.attempts,
        // Not the Error itself. `message` and `stack` are non-enumerable, so
        // an Error inside a structured log object serialises to `{}` and the
        // log says nothing at all -- which is exactly what a dead-letter
        // drill on staging produced (2026-09-20): five retries, five
        // `err: {}`. The one log line that explains why a message is about to
        // dead-letter has to carry the reason.
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      message.retry({
        delaySeconds: Math.min(300, 15 * 2 ** message.attempts),
      });
    }
  }
}
