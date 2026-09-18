import type { Env } from "../index";
import { postSlackAlert } from "../slack/alert";
import { handleEtlSyncBatch, type EtlSyncMessage } from "./etlSync";

/** The one field of a dead-lettered body that is safe to repeat outside our own logs. */
function messageType(body: unknown): string {
  const type = (body as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : "unknown";
}

/**
 * Dead-letter consumer (Phase 2.5.2): messages that exhausted their queue's
 * retries. Each is logged in full and acked, so it is visible in Workers Logs
 * rather than silently lost, and one alert per batch goes to Slack.
 *
 * The alert deliberately carries less than the log does. A dead-lettered body
 * can contain an order id or an email address, and a Slack channel has a
 * different and wider audience than our own logs, so the alert names the
 * queue, the message ids, the attempt counts and the message *type* -- enough
 * to know what broke and to find it in the logs, and nothing about whose
 * membership it was.
 */
export async function handleDeadLetterBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const summaries: string[] = [];
  for (const message of batch.messages) {
    console.error("Dead-lettered queue message", {
      queue: batch.queue,
      id: message.id,
      attempts: message.attempts,
      body: message.body,
    });
    summaries.push(
      `• \`${messageType(message.body)}\` (id \`${message.id}\`, ${message.attempts} attempts)`,
    );
    message.ack();
  }
  if (summaries.length === 0) {
    return;
  }
  const count = summaries.length;
  await postSlackAlert(
    env,
    [
      `:rotating_light: ${count} message${count === 1 ? "" : "s"} dead-lettered on \`${batch.queue}\``,
      ...summaries,
      "Full details are in Workers Logs; they are not repeated here because a dead-lettered body can contain member data.",
    ].join("\n"),
  );
}

/**
 * The Worker's single `queue()` entrypoint, routed by queue name. Names come
 * from vars because they differ per environment (queue names are
 * account-wide, e.g. `etl-sync-production` vs. `etl-sync-staging`).
 */
export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  if (batch.queue === env.ETL_SYNC_QUEUE_NAME) {
    return handleEtlSyncBatch(batch as MessageBatch<EtlSyncMessage>, env);
  }
  if (batch.queue === env.ETL_SYNC_DLQ_NAME) {
    return handleDeadLetterBatch(batch, env);
  }
  // Throwing (rather than acking) leaves the batch to be retried, so
  // messages aren't lost if a queue is bound before its handler ships.
  throw new Error(`No consumer registered for queue "${batch.queue}"`);
}
