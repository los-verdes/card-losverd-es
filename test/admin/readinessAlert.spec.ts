import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  failuresIn,
  readinessAlertText,
  reportReadiness,
  runReadinessCheck,
} from "../../src/admin/readinessAlert";
import { runPreflightChecks, type CheckGroup } from "../../src/admin/preflightChecks";

// The other half of this behaviour -- that a scheduled run reads a foreign
// webhook token as a warning rather than a failure -- is in preflight.spec.ts,
// where the BigCommerce fixtures make the check actually run. Asserted here it
// would pass vacuously: with no access token configured the whole group is
// skipped, so there is no verdict to be lenient about.

const SLACK_WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxx";

function group(title: string, results: CheckGroup["results"]): CheckGroup {
  return { title, results };
}

/** Captures Slack posts; any other outbound fetch fails the test loudly. */
function mockSlack(status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SLACK_WEBHOOK) return new Response("ok", { status });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function postedText(spy: ReturnType<typeof mockSlack>): string {
  const call = spy.mock.calls.find(([input]) => String(input) === SLACK_WEBHOOK);
  return JSON.parse(call![1]!.body as string).text;
}

beforeEach(() => {
  env.SLACK_ALERT_WEBHOOK_URL = SLACK_WEBHOOK;
  env.ENVIRONMENT = "staging";
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failuresIn", () => {
  it("keeps only failures, and says which group each came from", () => {
    const groups = [
      group("Storage", [
        { name: "R2", status: "ok", detail: "fine" },
        { name: "D1", status: "fail", detail: "migrations not applied" },
      ]),
      group("Apple", [
        { name: "Certificate", status: "warn", detail: "expires soon" },
        { name: "Key", status: "skip", detail: "not configured" },
        { name: "Chain", status: "fail", detail: "WWDR mismatch" },
      ]),
    ];

    expect(failuresIn(groups)).toEqual([
      { group: "Storage", name: "D1", detail: "migrations not applied" },
      { group: "Apple", name: "Chain", detail: "WWDR mismatch" },
    ]);
  });

  it("treats warn and skip as nothing to report", () => {
    // The rule this job inherits: a check that cannot run is a known state,
    // not a regression. Alerting on those would leave the channel noisy
    // until every credential everywhere is populated, which ends with
    // someone muting it.
    const groups = [
      group("Google Wallet", [
        { name: "Class", status: "skip", detail: "no credentials" },
        { name: "Cert", status: "warn", detail: "29 days left" },
      ]),
    ];

    expect(failuresIn(groups)).toEqual([]);
  });
});

describe("readinessAlertText", () => {
  it("names each failure and points at the page for the rest", () => {
    const text = readinessAlertText(
      [{ group: "Apple pass signing", name: "Certificate", detail: "Expired 3 days ago." }],
      "https://card.losverd.es",
    );

    expect(text).toContain("found a problem");
    expect(text).toContain("Apple pass signing -- Certificate");
    expect(text).toContain("Expired 3 days ago.");
    expect(text).toContain("https://card.losverd.es/admin/preflight");
  });

  it("counts several, and tolerates a base URL with a trailing slash", () => {
    const text = readinessAlertText(
      [
        { group: "A", name: "one", detail: "x" },
        { group: "B", name: "two", detail: "y" },
      ],
      "https://card.losverd.es/",
    );

    expect(text).toContain("found 2 problems");
    expect(text).toContain("https://card.losverd.es/admin/preflight");
    expect(text).not.toContain(".es//admin");
  });

  it("still says where to look when no base URL is configured", () => {
    expect(readinessAlertText([{ group: "A", name: "one", detail: "x" }], undefined)).toContain(
      "/admin/preflight",
    );
  });
});

describe("a scheduled run cannot tell which side of cutover it is on", () => {
  it("skips the origin check rather than comparing the configured origin with itself", async () => {
    // Passing PUBLIC_BASE_URL as the request URL would make this always
    // report "ok" -- an answer that looks like a verified fact and is
    // actually a tautology.
    const groups = await runPreflightChecks(env, null);
    const origin = groups
      .flatMap((g) => g.results)
      .find((r) => r.name === "Public base URL");

    expect(origin?.status).toBe("skip");
    expect(origin?.detail).toContain("ran on a schedule");
  });

});

describe("runReadinessCheck", () => {
  it("says nothing at all when nothing has failed", async () => {
    // Silence when healthy is the whole point: a job that posts "all clear"
    // weekly trains people to skim past it, and then reads identically to a
    // job that has quietly stopped noticing.
    const fetchSpy = mockSlack();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const posted = await reportReadiness(env, [
      group("Storage", [
        { name: "R2", status: "ok", detail: "fine" },
        { name: "D1", status: "warn", detail: "nearly full" },
      ]),
      group("Google Wallet", [{ name: "Class", status: "skip", detail: "no credentials" }]),
    ]);

    expect(posted).toBe(0);
    expect(fetchSpy.mock.calls.filter(([i]) => String(i) === SLACK_WEBHOOK)).toHaveLength(0);
  });

  it("posts once for several failures, not once each", async () => {
    const fetchSpy = mockSlack();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const posted = await reportReadiness(env, [
      group("Apple", [{ name: "Certificate", status: "fail", detail: "expired" }]),
      group("Storage", [{ name: "R2", status: "fail", detail: "missing templates" }]),
    ]);

    expect(posted).toBe(2);
    expect(fetchSpy.mock.calls.filter(([i]) => String(i) === SLACK_WEBHOOK)).toHaveLength(1);
    expect(postedText(fetchSpy)).toContain("found 2 problems");
  });

  it("posts one message naming every failure when something is wrong", async () => {
    const fetchSpy = mockSlack();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // An unset PUBLIC_BASE_URL is a genuine failure rather than a skip.
    env.PUBLIC_BASE_URL = "";

    const failures = await runReadinessCheck(env);

    expect(failures).toBeGreaterThan(0);
    const posted = postedText(fetchSpy);
    expect(posted).toContain("Readiness check found");
    // postSlackAlert prefixes the environment, so an alert can never be read
    // as production's when it came from staging.
    expect(posted).toContain("[staging]");
  });

  it("survives Slack being down rather than failing the scheduled run", async () => {
    // It runs inside the queue consumer; throwing here would retry and then
    // dead-letter, which posts another Slack alert through the same webhook.
    mockSlack(500);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.PUBLIC_BASE_URL = "";

    await expect(runReadinessCheck(env)).resolves.toBeGreaterThan(0);
  });
});
