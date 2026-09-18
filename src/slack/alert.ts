/**
 * Posting an operational alert to Slack, via an incoming webhook.
 *
 * Deliberately not the bot token the member sync uses (`membersEtl.ts`).
 * That token can read the workspace's user list, including every member's
 * email address; posting a line into one channel needs none of that, and an
 * incoming webhook URL grants exactly that and nothing else.
 *
 * Optional, like the other integrations here: with no webhook configured the
 * alert is skipped with a warning, so an environment without one still runs.
 */

import type { Env } from "../index";

/**
 * Posts `text` to the configured channel. Never throws: callers are queue
 * consumers and scheduled jobs, and an alert failing is not a reason to fail
 * -- or worse, retry -- the work it was reporting on.
 */
export async function postSlackAlert(env: Env, text: string): Promise<boolean> {
  if (!env.SLACK_ALERT_WEBHOOK_URL) {
    console.warn("postSlackAlert(): SLACK_ALERT_WEBHOOK_URL not configured, skipping");
    return false;
  }
  try {
    const res = await fetch(env.SLACK_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error("postSlackAlert(): Slack rejected the alert", {
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error("postSlackAlert(): couldn't reach Slack", {
      error: String(error),
    });
    return false;
  }
}
