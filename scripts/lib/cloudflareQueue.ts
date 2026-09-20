/**
 * Putting a message on a Cloudflare queue from outside the Worker.
 *
 * Two tools need this and a third would have copied it: `etl-run.mjs`, which
 * triggers a scheduled job on demand, and `queue-dlq-drill.mjs`, which proves
 * the dead-letter alert path. Queue ids are not in `wrangler.toml` -- it binds
 * by name -- so both have to look the id up before they can send anything.
 *
 * Import-free, so the `.mjs` tools can import it directly under Node's
 * TypeScript type stripping, matching `opItem.ts` and `workerSecrets.ts`
 * beside it.
 */

const DEFAULT_API = "https://api.cloudflare.com/client/v4";

export interface QueueApiOptions {
  token: string;
  accountId: string;
  /** Overridable so the tools can be exercised against a stub. */
  apiBase?: string;
  /** Aborts the calling tool, having said why. Never returns. */
  fail: (message: string) => never;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function call<T>(
  path: string,
  init: RequestInit,
  options: QueueApiOptions,
): Promise<T> {
  const res = await fetch(`${options.apiBase ?? DEFAULT_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
  });
  // Cloudflare answers with a JSON envelope even for errors, but a proxy or
  // an outage can still hand back HTML.
  const body = (await res.json().catch(() => null)) as CloudflareEnvelope<T> | null;
  if (!body?.success) {
    const error = body?.errors?.[0];
    return options.fail(
      `${path} -- HTTP ${res.status}${error?.message ? `: ${error.message}` : ""}`,
    );
  }
  return body.result as T;
}

/**
 * The id of the queue with this name, aborting with the names that do exist
 * when there is no match -- a typo and a queue that was never provisioned
 * look identical otherwise.
 */
export async function resolveQueueId(
  name: string,
  options: QueueApiOptions,
): Promise<string> {
  const queues = await call<{ queue_name: string; queue_id: string }[]>(
    `/accounts/${options.accountId}/queues`,
    { method: "GET" },
    options,
  );
  const match = queues.find((queue) => queue.queue_name === name);
  if (!match) {
    return options.fail(
      `no queue named ${name} on this account. Found: ${
        queues.map((queue) => queue.queue_name).join(", ") || "(none)"
      }`,
    );
  }
  return match.queue_id;
}

/** Puts one JSON message on the named queue. */
export async function sendQueueMessage(
  queueName: string,
  body: unknown,
  options: QueueApiOptions,
): Promise<void> {
  const queueId = await resolveQueueId(queueName, options);
  await call(
    `/accounts/${options.accountId}/queues/${queueId}/messages`,
    { method: "POST", body: JSON.stringify({ content_type: "json", body }) },
    options,
  );
}
