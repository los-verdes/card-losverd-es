// Proves the dead-letter alert path works, end to end, in a real
// environment: a message that cannot be handled goes onto the `etl-sync`
// queue, exhausts its retries, lands in the dead-letter queue, and the
// dead-letter consumer posts to Slack.
//
// Worth doing rather than trusting the unit tests. Those cover
// `handleDeadLetterBatch` and `postSlackAlert` in isolation; what they cannot
// cover is whether *this environment's* queue is bound to the right
// dead-letter queue, whether its consumer is deployed, and whether the
// webhook in its secrets points at a channel anyone reads. Every one of those
// is configuration, and configuration is what is actually wrong when an alert
// does not arrive.
//
// The message deliberately carries a type no handler knows. `dispatchEtlSyncMessage`
// throws on an unrecognised type by design (#127, so nothing is ever acked
// and silently discarded), which makes it the one failure that is guaranteed,
// repeatable, and touches no member data on its way.
//
// Usage:
//   just queue-dlq-drill              # staging
//   just queue-dlq-drill production   # refuses without --yes-production

const API = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

const env = process.argv[2] ?? "staging";
const confirmedProduction = process.argv.includes("--yes-production");

function fail(message) {
  console.error(`queue-dlq-drill: ${message}`);
  process.exit(1);
}

if (!token || !accountId) {
  fail("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
}
if (env === "production" && !confirmedProduction) {
  // A drill on production posts a real alert to the channel people watch,
  // and leaves a real dead-lettered message in the logs. That is sometimes
  // exactly what you want -- proving production's alerting before cutover --
  // but never by accident.
  fail(
    "refusing to drill production without --yes-production.\n" +
      "  It posts a genuine alert to the channel people watch. Staging is the default for a reason.",
  );
}

const queueName = `etl-sync-${env}`;

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!body?.success) {
    const error = body?.errors?.[0];
    fail(`${path} -- HTTP ${res.status}${error ? `: ${error.message}` : ""}`);
  }
  return body.result;
}

// Queue ids are not in wrangler.toml -- it binds by name -- so look it up.
const queues = await api(`/accounts/${accountId}/queues`, { method: "GET" });
const queue = queues.find((q) => q.queue_name === queueName);
if (!queue) {
  fail(
    `no queue named ${queueName} on this account. ` +
      `Found: ${queues.map((q) => q.queue_name).join(", ") || "(none)"}`,
  );
}

const sentAt = new Date().toISOString();
await api(`/accounts/${accountId}/queues/${queue.queue_id}/messages`, {
  method: "POST",
  body: JSON.stringify({
    content_type: "json",
    body: {
      type: "dlq_drill",
      note: "Deliberately unhandled. Proves the dead-letter alert path; safe to ignore.",
      sentAt,
    },
  }),
});

// From the backoff in src/queues/etlSync.ts: min(300, 15 * 2**attempts)
// seconds between attempts, over the five retries the consumer allows.
const delays = [1, 2, 3, 4, 5].map((n) => Math.min(300, 15 * 2 ** n));
const totalMinutes = Math.round(delays.reduce((a, b) => a + b, 0) / 60);

console.log(`Sent one unhandleable message to ${queueName} at ${sentAt}.

What should happen, in order:

  1. The consumer throws on it -- it has no handler, which is the point.
  2. It retries 5 times, backing off ${delays.join("s, ")}s.
  3. It lands in etl-sync-dlq-${env}.
  4. The dead-letter consumer posts to Slack, naming the queue, the message
     id, the attempt count and the type (\`dlq_drill\`) -- and nothing else,
     because a real dead-lettered body can contain member data.

Allow about ${totalMinutes} minutes before deciding it has failed. Most of that is
the backoff, and watching for the first minute proves nothing.

Watch it happen:

  npx wrangler tail ${env === "production" ? '--env=""' : `--env ${env}`} --format pretty

If no Slack message arrives but the tail shows "Dead-lettered queue message",
the queue wiring is fine and the problem is SLACK_ALERT_WEBHOOK_URL -- check
\`just secrets-status ${env}\` and that the webhook still points at a live channel.
If the tail shows nothing at all, the consumer is not deployed for this
environment.`);
