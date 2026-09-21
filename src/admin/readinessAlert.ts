/**
 * The readiness checks, run on a schedule and reported to Slack only when
 * something is wrong (los-verdes/card-losverd-es#95).
 *
 * `/admin/preflight` answers "is this environment ready?" for whoever opens
 * it. That is the wrong shape for the one thing here that fails silently
 * with time rather than with a change: the Apple pass certificate lasts a
 * year, and the last lapse was noticed when signing broke. A page nobody
 * opens reports nothing, and hanging the check off deploys would make the
 * warning's timing a function of how often we happen to deploy -- exactly
 * wrong for a quiet month, which is when a certificate is most likely to
 * run out unwatched.
 *
 * Two rules this inherits from the issue, both deliberate:
 *
 *   - **A check that cannot run is not a failure.** An absent credential is
 *     a known state, not a regression. Only `fail` is worth waking anyone
 *     for; `warn` and `skip` are for the page to show.
 *   - **Silence when healthy, by default.** A job that posts "all clear"
 *     weekly trains people to skim past it, and is indistinguishable from a
 *     job that has stopped noticing. `READINESS_POST_WHEN_HEALTHY = "true"`
 *     turns on an all-clear post as well, which is useful while the job is
 *     new and nobody yet trusts that it runs; without it, nothing is posted
 *     unless something is wrong.
 */

import { postSlackAlert } from "../slack/alert";
import type { Env } from "../index";
import { runPreflightChecks, type CheckGroup } from "./preflightChecks";

/** The failing checks across every group, flattened for reporting. */
export function failuresIn(
  groups: CheckGroup[],
): { group: string; name: string; detail: string }[] {
  return groups.flatMap((group) =>
    group.results
      .filter((result) => result.status === "fail")
      .map((result) => ({
        group: group.title,
        name: result.name,
        detail: result.detail,
      })),
  );
}

/**
 * The Slack message for a set of failures. Kept separate from sending so the
 * wording is testable without a webhook.
 *
 * Names the environment via `postSlackAlert`, which prefixes every alert, and
 * points at the page rather than repeating everything it would say -- the
 * detail belongs where the rest of the context is.
 */
export function readinessAlertText(
  failures: ReturnType<typeof failuresIn>,
  baseUrl: string | undefined,
): string {
  const lines = failures.map((f) => `• *${f.group} -- ${f.name}*: ${f.detail}`);
  const where = baseUrl ? ` ${baseUrl.replace(/\/+$/, "")}/admin/preflight` : " /admin/preflight";
  return [
    `Readiness check found ${failures.length === 1 ? "a problem" : `${failures.length} problems`}:`,
    ...lines,
    `Full report:${where}`,
  ].join("\n");
}

/** Whether a run with nothing failing should say so in Slack too. */
export function postsWhenHealthy(env: Pick<Env, "READINESS_POST_WHEN_HEALTHY">): boolean {
  return env.READINESS_POST_WHEN_HEALTHY?.trim().toLowerCase() === "true";
}

/**
 * The all-clear message. Counts what was not a pass, so a week that went
 * from no warnings to three reads differently from one that did not.
 */
export function readinessAllClearText(groups: CheckGroup[], baseUrl: string | undefined): string {
  const results = groups.flatMap((group) => group.results);
  const count = (status: string) => results.filter((result) => result.status === status).length;
  const where = baseUrl ? ` ${baseUrl.replace(/\/+$/, "")}/admin/preflight` : " /admin/preflight";
  return [
    `Readiness check: nothing failing (${results.length} checks; ${count("warn")} warnings, ${count("skip")} skipped).`,
    `Full report:${where}`,
  ].join("\n");
}

/**
 * Posts to Slack if any check failed -- or, with READINESS_POST_WHEN_HEALTHY
 * on, if none did -- and returns how many failed.
 *
 * Separate from running the checks so that "healthy means silence" can be
 * asserted against a known-healthy set of results. Building an environment
 * with nothing wrong in it is impractical in a test -- an unconfigured one
 * fails half a dozen checks by design -- and a test that only verifies
 * silence when it happens to find silence verifies nothing.
 */
export async function reportReadiness(
  env: Env,
  groups: CheckGroup[],
): Promise<number> {
  const failures = failuresIn(groups);
  if (failures.length === 0) {
    console.log("readiness check: nothing to report", {
      groups: groups.length,
    });
    if (postsWhenHealthy(env)) {
      await postSlackAlert(env, readinessAllClearText(groups, env.PUBLIC_BASE_URL));
    }
    return 0;
  }
  console.warn("readiness check: failures found", {
    count: failures.length,
    names: failures.map((f) => f.name),
  });
  await postSlackAlert(env, readinessAlertText(failures, env.PUBLIC_BASE_URL));
  return failures.length;
}

/**
 * Runs every automated readiness check and reports what failed. Returns the
 * number of failures, so a caller can tell "ran and found nothing" from
 * "did not run".
 *
 * `null` for the request URL is deliberate and load-bearing: there is no
 * request here, and `runPreflightChecks` treats that as "cannot tell which
 * side of cutover this is", which is what stops a deliberate pre-cutover
 * state being reported as a failure every week.
 */
export async function runReadinessCheck(
  env: Env,
  now: Date = new Date(),
): Promise<number> {
  return reportReadiness(env, await runPreflightChecks(env, null, now));
}
