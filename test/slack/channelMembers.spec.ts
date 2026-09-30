import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_CONVERSATIONS_LIST_URL,
  SLACK_CONVERSATIONS_MEMBERS_URL,
  syncSlackChannelMembers,
} from "../../src/slack/channelMembers";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
import type { CardGroup } from "../../src/themes/groups";

const GROUPS: CardGroup[] = [{ id: "pringles", label: "Los Pringles", slackChannel: "los-pringles" }];
const PRINGLES: CardTheme = { ...CLASSIC_THEME, id: "pringles-theme", label: "Los Pringles", group: "pringles" };
const THEMES = [CLASSIC_THEME, PRINGLES];

interface FakeSlack {
  /** Channels `conversations.list` reports, by name -> id. */
  channels?: Record<string, string>;
  /** Members per channel id, served one page per inner array. */
  members?: Record<string, string[][]>;
  /** An `ok: false` error to give for a method. */
  errors?: { list?: string; members?: string };
  /** An HTTP status to fail with instead. */
  httpStatus?: number;
}

/** Answers Slack's two methods from `fake`, paging members by cursor. */
function mockSlack(fake: FakeSlack) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const base = `${url.origin}${url.pathname}`;
    if (fake.httpStatus) return new Response("nope", { status: fake.httpStatus, headers: { "Retry-After": "30" } });
    if (base === SLACK_CONVERSATIONS_LIST_URL) {
      if (fake.errors?.list) return Response.json({ ok: false, error: fake.errors.list });
      const channels = Object.entries(fake.channels ?? {}).map(([name, id]) => ({ id, name }));
      return Response.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
    }
    if (base === SLACK_CONVERSATIONS_MEMBERS_URL) {
      if (fake.errors?.members) return Response.json({ ok: false, error: fake.errors.members });
      const pages = fake.members?.[url.searchParams.get("channel") ?? ""] ?? [[]];
      const index = Number(url.searchParams.get("cursor") ?? 0);
      const next = index + 1 < pages.length ? String(index + 1) : "";
      return Response.json({ ok: true, members: pages[index], response_metadata: { next_cursor: next } });
    }
    throw new Error(`unexpected fetch ${base}`);
  });
}

async function stored(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT slack_id FROM slack_channel_members WHERE channel_name = 'los-pringles' ORDER BY slack_id",
  ).all<{ slack_id: string }>();
  return results.map((row) => row.slack_id);
}

async function lastUpdated(email: string): Promise<number> {
  return (await env.DB.prepare("SELECT last_updated_at FROM members WHERE email = ?").bind(email).first<{ last_updated_at: number }>())!
    .last_updated_at;
}

beforeEach(async () => {
  env.SLACK_BOT_TOKEN = "xoxb-test";
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const [id, email] of [["U1", "jane@example.com"], ["U2", "pat@example.com"], ["U3", "sam@example.com"]]) {
    await env.DB.prepare("INSERT INTO slack_users (slack_id, email, synced_at) VALUES (?, ?, 1)").bind(id, email).run();
  }
  for (const [id, email] of [["LV-1", "jane@example.com"], ["LV-2", "pat@example.com"]]) {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
       VALUES (?, 'A', 'B', ?, '2099-01-01', '2021-01-01', 'token', 1)`,
    )
      .bind(id, email)
      .run();
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.SLACK_BOT_TOKEN = undefined;
  await env.DB.exec("DELETE FROM slack_channel_members");
  await env.DB.exec("DELETE FROM member_card_themes");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM slack_users");
});

describe("syncSlackChannelMembers", () => {
  it("stores everyone in each group's channel, across pages", async () => {
    mockSlack({ channels: { "los-pringles": "C1", general: "C0" }, members: { C1: [["U1"], ["U2"]] } });

    const results = await syncSlackChannelMembers(env, GROUPS, THEMES);

    expect(results).toEqual([{ channel: "los-pringles", members: 2, removed: 0 }]);
    expect(await stored()).toEqual(["U1", "U2"]);
  });

  it("removes whoever has left, and tells the passes of a leaver who had chosen the group's theme", async () => {
    mockSlack({ channels: { "los-pringles": "C1" }, members: { C1: [["U1", "U2"]] } });
    await syncSlackChannelMembers(env, GROUPS, THEMES);
    await env.DB.prepare("INSERT INTO member_card_themes (email, theme_id, source) VALUES ('pat@example.com', 'pringles-theme', 'member')").run();
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {}); // no APNs configured here
    mockSlack({ channels: { "los-pringles": "C1" }, members: { C1: [["U1"]] } });

    const results = await syncSlackChannelMembers(env, GROUPS, THEMES);

    expect(results).toEqual([{ channel: "los-pringles", members: 1, removed: 1 }]);
    expect(await stored()).toEqual(["U1"]);
    // Pat's card is back to their default, so it has changed; Jane's has not.
    expect(await lastUpdated("pat@example.com")).toBeGreaterThan(1);
    expect(await lastUpdated("jane@example.com")).toBe(1);
  });

  it.each(["missing_scope", "not_allowed_token_type"])(
    "keeps the stored members, and warns, when Slack refuses to list channels (%s)",
    async (error) => {
      await env.DB.prepare("INSERT INTO slack_channel_members VALUES ('los-pringles', 'U1', 1)").run();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockSlack({ errors: { list: error } });

      const results = await syncSlackChannelMembers(env, GROUPS, THEMES);

      expect(results).toEqual([{ channel: "los-pringles", members: null, removed: 0 }]);
      expect(await stored()).toEqual(["U1"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("channels:read"));
    },
  );

  it("keeps the stored members when no channel has the group's name, or it cannot be read", async () => {
    await env.DB.prepare("INSERT INTO slack_channel_members VALUES ('los-pringles', 'U1', 1)").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockSlack({ channels: { general: "C0" } });
    expect(await syncSlackChannelMembers(env, GROUPS, THEMES)).toEqual([{ channel: "los-pringles", members: null, removed: 0 }]);
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSlack({ channels: { "los-pringles": "C1" }, errors: { members: "not_in_channel" } });
    expect(await syncSlackChannelMembers(env, GROUPS, THEMES)).toEqual([{ channel: "los-pringles", members: null, removed: 0 }]);

    expect(await stored()).toEqual(["U1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("#los-pringles"));
  });

  it("throws, for the queue to retry, on a failure worth retrying", async () => {
    mockSlack({ httpStatus: 429 });
    await expect(syncSlackChannelMembers(env, GROUPS, THEMES)).rejects.toThrow(/HTTP 429 \(Retry-After: 30s\)/);

    vi.restoreAllMocks();
    mockSlack({ errors: { list: "ratelimited" } });
    await expect(syncSlackChannelMembers(env, GROUPS, THEMES)).rejects.toThrow(/ratelimited/);
  });

  it("does nothing, with a warning, until the bot token is set", async () => {
    env.SLACK_BOT_TOKEN = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");

    expect(await syncSlackChannelMembers(env, GROUPS, THEMES)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SLACK_BOT_TOKEN"));
  });
});
