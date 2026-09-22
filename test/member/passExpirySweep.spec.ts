import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAPSED_REFRESH_BATCH,
  MAX_MEMBERS_PER_SWEEP,
  PASS_EXPIRY_SWEEP_JOB,
  refreshLapsedPasses,
  runPassExpirySweep,
} from "../../src/member/passExpirySweep";
import { handleEtlSyncBatch, type EtlSyncMessage } from "../../src/queues/etlSync";

const NOW = new Date("2026-09-22T00:30:00Z"); // yesterday is 2026-09-21

async function insertMember(id: string, expiration: string, email = `${id.toLowerCase()}@example.com`) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Test', 'Member', ?, ?, '2021-01-01', 'token', 1)`,
  )
    .bind(id, email, expiration)
    .run();
}

async function touched(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT member_id FROM members WHERE last_updated_at > 1 ORDER BY member_id").all<{
    member_id: string;
  }>();
  return results.map((row) => row.member_id);
}

async function setWatermark(date: string) {
  await env.DB.prepare("INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES (?, ?, 0)")
    .bind(PASS_EXPIRY_SWEEP_JOB, Date.parse(`${date}T00:00:00Z`))
    .run();
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // No wallet is configured here, so a refresh makes no outbound call; any
  // that does is a bug, and so is anything that tries to send an email.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`unexpected fetch: ${input instanceof Request ? input.url : String(input)}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM etl_sync_state");
});

describe("the daily pass expiry sweep (#295)", () => {
  it("refreshes yesterday's lapses on its first run, and nothing older or still current", async () => {
    await insertMember("LV-A", "2026-09-21");
    await insertMember("LV-B", "2026-09-20"); // lapsed before the sweep existed
    await insertMember("LV-C", "2026-09-22"); // today: still current until 23:59:59 UTC

    const result = await runPassExpirySweep(env, NOW);

    expect(await touched()).toEqual(["LV-A"]);
    expect(result).toEqual({ refreshed: 1, coveredThrough: "2026-09-21" });
  });

  it("catches up on days it missed, from its watermark", async () => {
    await setWatermark("2026-09-18");
    await insertMember("LV-A", "2026-09-18"); // already covered
    await insertMember("LV-B", "2026-09-19");
    await insertMember("LV-C", "2026-09-21");

    await runPassExpirySweep(env, NOW);

    expect(await touched()).toEqual(["LV-B", "LV-C"]);
  });

  it("does not repeat itself on a second run the same day", async () => {
    await insertMember("LV-A", "2026-09-21");
    await runPassExpirySweep(env, NOW);
    await env.DB.exec("UPDATE members SET last_updated_at = 1");

    expect((await runPassExpirySweep(env, NOW)).refreshed).toBe(0);
    expect(await touched()).toEqual([]);
  });

  it("leaves revoked and expelled members alone", async () => {
    await insertMember("LV-A", "2026-09-21");
    await insertMember("LV-B", "2026-09-21");
    await insertMember("LV-C", "2026-09-21");
    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('LV-B')").run();
    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES ('lv-c@example.com')").run();

    await runPassExpirySweep(env, NOW);

    expect(await touched()).toEqual(["LV-A"]);
  });

  it("stops at its cap, and covers only the dates it finished", async () => {
    await setWatermark("2026-09-19");
    for (let i = 0; i < MAX_MEMBERS_PER_SWEEP; i++) {
      await insertMember(`LV-${String(i).padStart(4, "0")}`, "2026-09-21");
    }
    await insertMember("LV-EARLY", "2026-09-20");

    const result = await runPassExpirySweep(env, NOW);

    expect(result.refreshed).toBe(MAX_MEMBERS_PER_SWEEP);
    // The batch ended partway through 2026-09-21, so that date is not yet covered.
    expect(result.coveredThrough).toBe("2026-09-20");
  });
});

describe("the one-off refresh of already-lapsed passes (#295)", () => {
  it("refreshes lapsed members in id order, skipping current and revoked ones", async () => {
    await insertMember("LV-A", "2025-01-01");
    await insertMember("LV-B", "2026-09-22"); // still current today
    await insertMember("LV-C", "2024-06-30");
    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('LV-C')").run();

    expect(await refreshLapsedPasses(env, "", NOW)).toBeNull();
    expect(await touched()).toEqual(["LV-A"]);
  });

  it("hands back a cursor when a batch is full, and resumes after it", async () => {
    for (let i = 0; i < LAPSED_REFRESH_BATCH + 1; i++) {
      await insertMember(`LV-${String(i).padStart(4, "0")}`, "2025-01-01");
    }

    const cursor = await refreshLapsedPasses(env, "", NOW);
    expect(cursor).toBe(`LV-${String(LAPSED_REFRESH_BATCH - 1).padStart(4, "0")}`);
    expect(await refreshLapsedPasses(env, cursor!, NOW)).toBeNull();
    expect((await touched()).length).toBe(LAPSED_REFRESH_BATCH + 1);
  });
});

describe("queue messages", () => {
  const realQueue = env.ETL_SYNC_QUEUE;
  let sent: EtlSyncMessage[];

  beforeEach(() => {
    sent = [];
    (env as { ETL_SYNC_QUEUE?: Queue<EtlSyncMessage> }).ETL_SYNC_QUEUE = {
      send: async (message: EtlSyncMessage) => {
        sent.push(message);
      },
    } as unknown as Queue<EtlSyncMessage>;
  });

  afterEach(() => {
    env.ETL_SYNC_QUEUE = realQueue;
  });

  function run(body: EtlSyncMessage) {
    const message = { id: "1", timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const batch = { queue: "etl-sync-production", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() };
    return handleEtlSyncBatch(batch as unknown as MessageBatch<EtlSyncMessage>, env).then(() => message);
  }

  it("runs the daily sweep and acks", async () => {
    const message = await run({ type: "run_pass_expiry_sweep" });

    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("chains the one-off refresh until a batch comes back short", async () => {
    for (let i = 0; i < LAPSED_REFRESH_BATCH; i++) {
      await insertMember(`LV-${String(i).padStart(4, "0")}`, "2020-01-01");
    }

    await run({ type: "refresh_lapsed_passes" });
    expect(sent).toEqual([{ type: "refresh_lapsed_passes", afterMemberId: `LV-${String(LAPSED_REFRESH_BATCH - 1).padStart(4, "0")}` }]);

    await run(sent[0]);
    expect(sent).toHaveLength(1);
  });
});
