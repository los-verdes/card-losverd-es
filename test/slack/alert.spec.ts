import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postSlackAlert } from "../../src/slack/alert";

/**
 * These alerts are the only thing that speaks up when a sync dies quietly, so
 * what they say matters as much as that they are sent. The environment label
 * in particular is applied here rather than at each call site, which is the
 * property worth pinning: a new alert should not be able to arrive without
 * one.
 */

const WEBHOOK = "https://hooks.slack.example/T/B/X";

/** Captures what would be posted, and answers as Slack does. */
function mockSlack(ok = true) {
  const posts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    posts.push(JSON.parse(String(init?.body)).text);
    return new Response(ok ? "ok" : "no", { status: ok ? 200 : 500 });
  });
  return posts;
}

const withEnv = (overrides: Record<string, unknown>) =>
  ({ ...env, SLACK_ALERT_WEBHOOK_URL: WEBHOOK, ...overrides }) as typeof env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postSlackAlert", () => {
  it("says which environment an alert came from", async () => {
    const posts = mockSlack();

    await postSlackAlert(withEnv({ ENVIRONMENT: "staging" }), "something happened");

    expect(posts).toEqual(["`[staging]` something happened"]);
  });

  it("labels production too, rather than leaving it to be assumed", async () => {
    const posts = mockSlack();

    await postSlackAlert(withEnv({ ENVIRONMENT: "production" }), "something happened");

    expect(posts[0]).toContain("[production]");
  });

  it("says so when it cannot tell, instead of sending an unlabelled alert", async () => {
    // An alert with no marker reads as "probably production" to anyone in a
    // hurry, which is the wrong way round for this to fail.
    const posts = mockSlack();

    await postSlackAlert(withEnv({ ENVIRONMENT: "   " }), "something happened");

    expect(posts[0]).toContain("[unknown environment]");
  });

  it("keeps a multi-line alert's body intact under the label", async () => {
    const posts = mockSlack();

    await postSlackAlert(withEnv({ ENVIRONMENT: "staging" }), "first\nsecond\nthird");

    expect(posts[0]).toBe("`[staging]` first\nsecond\nthird");
  });

  it("skips, without throwing, when no webhook is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = mockSlack();

    await expect(
      postSlackAlert(withEnv({ SLACK_ALERT_WEBHOOK_URL: undefined }), "ignored"),
    ).resolves.toBe(false);

    expect(posts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_ALERT_WEBHOOK_URL"),
    );
  });

  it("reports a rejection without throwing, so it can't fail the work it describes", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSlack(false);

    await expect(
      postSlackAlert(withEnv({ ENVIRONMENT: "staging" }), "something happened"),
    ).resolves.toBe(false);

    expect(errors).toHaveBeenCalledWith(
      "postSlackAlert(): Slack rejected the alert",
      expect.objectContaining({ status: 500 }),
    );
  });

  it("survives Slack being unreachable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no route to host"));

    await expect(
      postSlackAlert(withEnv({ ENVIRONMENT: "staging" }), "something happened"),
    ).resolves.toBe(false);

    expect(errors).toHaveBeenCalledWith(
      "postSlackAlert(): couldn't reach Slack",
      expect.objectContaining({ error: expect.stringContaining("no route to host") }),
    );
  });
});
