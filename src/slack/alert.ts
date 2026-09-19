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
 *
 * Every alert is labelled with the environment it came from, here rather than
 * at each call site, so that a new alert cannot be added without one. The two
 * environments are expected to post to different channels -- their webhook
 * URLs are separate secrets -- but nothing enforces that, and a screenshot or
 * a forwarded message carries no channel with it either way.
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
  // Labelled even when it cannot be determined: an alert with no marker at
  // all would read as "probably production" to anyone in a hurry, which is
  // the wrong way for this to fail.
  const environment = env.ENVIRONMENT?.trim() || "unknown environment";
  try {
    const res = await fetch(env.SLACK_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `\`[${environment}]\` ${text}` }),
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
