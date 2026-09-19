import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runSlackMembersEtl,
  SLACK_USERS_LIST_URL,
  type SlackMember,
} from "../../src/slack/membersEtl";

interface SlackUserRow {
  slack_id: string;
  team_id: string | null;
  name: string | null;
  real_name: string | null;
  email: string | null;
  deleted: number;
  tz_offset: number | null;
  profile: string | null;
  is_admin: number;
  is_bot: number;
  is_restricted: number;
  has_2fa: number;
  updated: number | null;
  synced_at: number;
}

const JANE: SlackMember = {
  id: "U001",
  team_id: "T001",
  name: "jane",
  real_name: "Jane Doe",
  deleted: false,
  color: "9f69e7",
  tz: "America/Chicago",
  tz_label: "Central Daylight Time",
  tz_offset: -18000,
  profile: { email: "  Jane@Example.COM ", first_name: "Jane", last_name: "Doe" },
  is_admin: true,
  is_owner: false,
  is_primary_owner: false,
  is_restricted: false,
  is_ultra_restricted: false,
  is_bot: false,
  is_app_user: false,
  is_email_confirmed: true,
  has_2fa: true,
  who_can_share_contact_card: "EVERYONE",
  updated: 1726500000,
};

/** A bot: no email, and most optional fields absent entirely. */
const BOT: SlackMember = { id: "B001", name: "verde-bot", is_bot: true, profile: {} };

/** Slack's bare-minimum shape, without even a `profile`. */
const SPARSE: SlackMember = { id: "U999" };

/** Serves `pages` in order, keyed off the `cursor` query parameter. */
function mockSlackPages(pages: SlackMember[][]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(`${url.origin}${url.pathname}`).toBe(SLACK_USERS_LIST_URL);
    const cursor = url.searchParams.get("cursor");
    const index = cursor ? Number(cursor.replace("page-", "")) : 0;
    const next = index + 1 < pages.length ? `page-${index + 1}` : "";
    return Response.json({
      ok: true,
      members: pages[index],
      response_metadata: { next_cursor: next },
    });
  });
}

async function allRows(): Promise<SlackUserRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM slack_users ORDER BY slack_id",
  ).all<SlackUserRow>();
  return results;
}

beforeEach(() => {
  env.SLACK_BOT_TOKEN = "xoxb-test-token";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM slack_users");
});

describe("runSlackMembersEtl", () => {
  it("skips with a warning, and calls nothing, until SLACK_BOT_TOKEN is set", async () => {
    env.SLACK_BOT_TOKEN = undefined;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await runSlackMembersEtl(env)).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_BOT_TOKEN"));
  });

  it("follows the cursor across pages and stores every member", async () => {
    const fetchSpy = mockSlackPages([[JANE], [BOT, SPARSE]]);

    expect(await runSlackMembersEtl(env)).toBe(3);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchSpy.mock.calls[0];
    expect(String(firstUrl)).toBe(`${SLACK_USERS_LIST_URL}?limit=200`);
    expect((firstInit!.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-test-token",
    );
    expect(String(fetchSpy.mock.calls[1][0])).toContain("cursor=page-1");
    expect((await allRows()).map((row) => row.slack_id)).toEqual(["B001", "U001", "U999"]);
  });

  it("maps Slack's user object onto the table's columns", async () => {
    mockSlackPages([[JANE, BOT, SPARSE]]);
    const before = Date.now();

    await runSlackMembersEtl(env);

    const [bot, jane, sparse] = await allRows();
    expect(jane).toMatchObject({
      team_id: "T001",
      name: "jane",
      real_name: "Jane Doe",
      email: "jane@example.com",
      deleted: 0,
      tz_offset: -18000,
      is_admin: 1,
      is_bot: 0,
      has_2fa: 1,
      updated: 1726500000,
    });
    expect(JSON.parse(jane.profile!)).toEqual(JANE.profile);
    expect(jane.synced_at).toBeGreaterThanOrEqual(before);
    expect(bot).toMatchObject({ email: null, is_bot: 1, is_admin: 0, profile: "{}" });
    expect(sparse).toMatchObject({
      name: null,
      email: null,
      profile: null,
      tz_offset: null,
      updated: null,
      deleted: 0,
    });
  });

  it("updates existing rows in place, including a member who was deactivated", async () => {
    mockSlackPages([[JANE]]);
    await runSlackMembersEtl(env);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSlackPages([[{ ...JANE, deleted: true, real_name: "Jane Q. Doe", is_admin: false }]]);

    await runSlackMembersEtl(env);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deleted: 1, real_name: "Jane Q. Doe", is_admin: 0 });
  });

  it("removes someone the workspace no longer lists", async () => {
    mockSlackPages([[JANE, { ...JANE, id: "U002", name: "sam" }]]);
    await runSlackMembersEtl(env);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSlackPages([[JANE]]);

    await runSlackMembersEtl(env);

    expect((await allRows()).map((row) => row.slack_id)).toEqual([JANE.id]);
  });

  it("clears out the previous workspace when the token is pointed at another one", async () => {
    // The case that matters for #133: swapping an environment's Slack app
    // must not leave the old workspace's people behind, counted as current
    // by reports that never look at `team_id`.
    mockSlackPages([[JANE]]);
    await runSlackMembersEtl(env);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSlackPages([[{ ...JANE, id: "U900", team_id: "T-OTHER", name: "someone-else" }]]);

    await runSlackMembersEtl(env);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slack_id: "U900", team_id: "T-OTHER" });
  });

  it("leaves the table alone when the list comes back empty", async () => {
    // A token that can no longer see anyone is far likelier to be a broken
    // token than an empty workspace, and emptying the table on one bad run
    // is not recoverable without another successful one.
    mockSlackPages([[JANE]]);
    await runSlackMembersEtl(env);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSlackPages([[]]);

    expect(await runSlackMembersEtl(env)).toBe(0);
    expect(await allRows()).toHaveLength(1);
  });

  it("handles an empty workspace page without touching D1", async () => {
    mockSlackPages([[]]);

    expect(await runSlackMembersEtl(env)).toBe(0);
    expect(await allRows()).toEqual([]);
  });

  it("tolerates a response with no members or response_metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    expect(await runSlackMembersEtl(env)).toBe(0);
  });

  it("throws on a Slack-level error (HTTP 200, ok: false) so the queue retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "missing_scope" }),
    );

    await expect(runSlackMembersEtl(env)).rejects.toThrow("missing_scope");
  });

  it("throws on ok: false even when Slack gives no error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false }));

    await expect(runSlackMembersEtl(env)).rejects.toThrow("unknown error");
  });

  it("throws on a rate limit, reporting Retry-After", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
    );

    await expect(runSlackMembersEtl(env)).rejects.toThrow("HTTP 429 (Retry-After: 30s)");
  });

  it("throws on other HTTP failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 503 }));

    await expect(runSlackMembersEtl(env)).rejects.toThrow(/HTTP 503$/);
  });

  it("keeps earlier pages when a later page fails", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          ok: true,
          members: [JANE],
          response_metadata: { next_cursor: "page-1" },
        });
      }
      return new Response("oops", { status: 500 });
    });

    await expect(runSlackMembersEtl(env)).rejects.toThrow("HTTP 500");
    expect(await allRows()).toHaveLength(1);
  });

  it("gives up if the cursor never ends", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ok: true, members: [], response_metadata: { next_cursor: "again" } }),
    );

    await expect(runSlackMembersEtl(env)).rejects.toThrow("gave up after 1000 pages");
    expect(fetchSpy).toHaveBeenCalledTimes(1000);
  });
});
