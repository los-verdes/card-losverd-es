// Runs one of the scheduled jobs now, instead of waiting for its cron.
//
// The jobs in `src/scheduled.ts` only ever run on a timer, which makes two
// ordinary things awkward: watching a job the first time before trusting it
// to a schedule, and re-running one after fixing whatever made it fail. Both
// currently mean editing `wrangler.toml` or waiting.
//
// It enqueues rather than executing: the message goes onto the same
// `etl-sync` queue the cron would put it on, so the job runs exactly as it
// runs on a schedule, with the same retries, the same dead-letter queue and
// the same alerting. A tool that ran the work some other way would prove the
// work runs, not that the scheduled path does.
//
// Usage:
//   just etl-run staging slack        # the Slack members sync
//   just etl-run staging resync       # the BigCommerce order resync
//   just etl-run staging full-resync  # the same, over the whole store
//   just etl-run staging readiness    # the readiness checks
//   just etl-run production slack --yes-production

import { sendQueueMessage } from "./lib/cloudflareQueue.ts";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiBase = process.env.CLOUDFLARE_API_BASE;

function fail(message) {
  console.error(`etl-run: ${message}`);
  process.exit(1);
}

/**
 * Short names for the message types in `src/queues/etlSync.ts`. Deliberately
 * not the raw type strings: those are an internal contract, and asking
 * someone to type `run_slack_members_etl` invites a typo that fails only
 * after the message has been accepted and dead-lettered.
 */
const JOBS = {
  slack: {
    message: { type: "run_slack_members_etl" },
    does: "Copies the Slack workspace's user list into D1, for cross-referencing members against Slack accounts. A full refresh: it removes rows it did not see this run.",
  },
  resync: {
    message: { type: "sync_subscriptions_etl" },
    does: "Re-reads recent BigCommerce orders and rebuilds any membership they touch. Never emails anyone.",
  },
  "full-resync": {
    message: { type: "sync_subscriptions_etl", loadAll: true },
    does: "Re-reads every order in the BigCommerce store, not just recent ones, and rebuilds every membership. For a database that was just rebuilt or imported (docs/cutover.md step 8). Never emails anyone.",
  },
  readiness: {
    message: { type: "run_readiness_check" },
    does: "Runs the /admin/preflight checks and posts to Slack only if one has failed.",
  },
};

const env = process.argv[2];
const job = process.argv[3];
const confirmedProduction = process.argv.includes("--yes-production");

if (!token || !accountId) {
  fail("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
}
if (!env || !job || !JOBS[job]) {
  fail(
    `usage: etl-run <env> <${Object.keys(JOBS).join("|")}>\n` +
      Object.entries(JOBS)
        .map(([name, { does }]) => `  ${name.padEnd(10)} ${does}`)
        .join("\n"),
  );
}
if (env === "production" && !confirmedProduction) {
  // Running a job early against production is legitimate -- it is how the
  // first full resync happens at cutover -- but it touches real member data
  // and should never be a typo away.
  fail("refusing to run against production without --yes-production");
}

await sendQueueMessage(`etl-sync-${env}`, JOBS[job].message, {
  token,
  accountId,
  apiBase,
  fail,
});

console.log(`Queued ${job} on etl-sync-${env}.

${JOBS[job].does}

It runs through the queue exactly as the cron would, so a failure retries and
eventually dead-letters with a Slack alert rather than disappearing.

Watch it:  npx wrangler tail ${env === "production" ? '--env=""' : `--env ${env}`} --format pretty`);
