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
// The message is a real member of the `etl-sync` union, `dlq_drill`, whose
// handler throws on purpose. Named rather than relying on an unrecognised
// type, so the drill does not depend on whatever `default:` happens to do,
// and so a `dlq_drill` in the logs or in Slack is obviously a drill rather
// than something to investigate. It carries no member data either way.
//
// Two modes, because they prove different things:
//
//   default    onto `etl-sync`, where it fails, retries, and dead-letters.
//              Proves the whole chain -- including that this environment's
//              queue is bound to the right dead-letter queue, which is the
//              part no test can see. Takes about thirteen minutes.
//
//   --direct   straight onto the dead-letter queue. Proves the consumer and
//              the webhook, in seconds, and proves nothing about the binding
//              or the retry configuration. The right one for "I rotated the
//              webhook, does it still reach the channel".
//
// Usage:
//   just queue-dlq-drill                        # staging, full chain
//   just queue-dlq-drill staging --direct       # staging, seconds
//   just queue-dlq-drill production             # refuses without --yes-production

import { sendQueueMessage } from "./lib/cloudflareQueue.ts";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiBase = process.env.CLOUDFLARE_API_BASE;

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

const direct = process.argv.includes("--direct");
const queueName = direct ? `etl-sync-dlq-${env}` : `etl-sync-${env}`;

const sentAt = new Date().toISOString();
await sendQueueMessage(
  queueName,
  {
    type: "dlq_drill",
    note: "A drill. Proves the dead-letter alert path; safe to ignore.",
    sentAt,
  },
  { token, accountId, apiBase, fail },
);

// From the backoff in src/queues/etlSync.ts: min(300, 15 * 2**attempts)
// seconds between attempts, over the five retries the consumer allows.
const delays = [1, 2, 3, 4, 5].map((n) => Math.min(300, 15 * 2 ** n));
const totalMinutes = Math.round(delays.reduce((a, b) => a + b, 0) / 60);

const tail = `npx wrangler tail ${env === "production" ? '--env=""' : `--env ${env}`} --format pretty`;

console.log(
  direct
    ? `Sent one drill message straight to ${queueName} at ${sentAt}.

The dead-letter consumer should post to Slack within seconds, naming the
queue, the message id, the attempt count and the type (\`dlq_drill\`) -- and
nothing else, because a real dead-lettered body can contain member data.

This proves the dead-letter consumer is deployed and its webhook reaches a
channel someone reads. It deliberately proves nothing about how a message
gets there: it skipped the retries and the dead_letter_queue binding
entirely. Run without --direct for that.

Watch it:  ${tail}`
    : `Sent one drill message to ${queueName} at ${sentAt}.

What should happen, in order:

  1. Its handler throws -- deliberately; that is what dlq_drill is for.
  2. It retries 5 times, backing off ${delays.join("s, ")}s.
  3. It lands in etl-sync-dlq-${env}, because the consumer is configured to
     send it there. That binding is the thing this mode proves and no test
     can.
  4. The dead-letter consumer posts to Slack, naming the queue, the message
     id, the attempt count and the type -- and nothing else, because a real
     dead-lettered body can contain member data.

Allow about ${totalMinutes} minutes before deciding it has failed. Most of that is
backoff, and watching the first minute proves nothing. Use --direct if you
only need to know whether the alert reaches Slack.

Watch it:  ${tail}

If no Slack message arrives but the tail shows "Dead-lettered queue message",
the queue wiring is fine and the problem is SLACK_ALERT_WEBHOOK_URL -- check
\`just secrets-status ${env}\` and that the webhook still points at a live
channel. If the tail shows nothing at all, the consumer is not deployed for
this environment.`,
);
