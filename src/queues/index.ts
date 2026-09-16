import type { Env } from "../index";
import { handleEtlSyncBatch, type EtlSyncMessage } from "./etlSync";

/**
 * Dead-letter consumer (Phase 2.5.2): messages that exhausted their
 * queue's retries. Logged loudly and acked so they're visible in Workers
 * logs/tail rather than silently lost. The plan's Slack notification is a
 * follow-up once the Slack integration exists.
 */
export async function handleDeadLetterBatch(
  batch: MessageBatch<unknown>,
): Promise<void> {
  for (const message of batch.messages) {
    console.error("Dead-lettered queue message", {
      queue: batch.queue,
      id: message.id,
      attempts: message.attempts,
      body: message.body,
    });
    message.ack();
  }
}

/** The Worker's single `queue()` entrypoint, routed by queue name. */
export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  switch (batch.queue) {
    case "etl-sync":
      return handleEtlSyncBatch(batch as MessageBatch<EtlSyncMessage>, env);
    case "etl-sync-dlq":
      return handleDeadLetterBatch(batch);
    default:
      // Throwing (rather than acking) leaves the batch to be retried, so
      // messages aren't lost if a queue is bound before its handler ships.
      throw new Error(`No consumer registered for queue "${batch.queue}"`);
  }
}
