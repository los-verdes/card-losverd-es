import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASS_REFRESH_BATCH, refreshInstalledPasses, type PassRefreshCursor } from "../../src/member/passRefresh";

async function insertMember(id: string, email: string, userId: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at, user_id)
     VALUES (?, 'Test', 'Member', ?, '2099-01-01', 'token', 1, ?)`,
  )
    .bind(id, email, userId)
    .run();
}

const refreshedIds = async () =>
  (await env.DB.prepare("SELECT member_id FROM members WHERE last_updated_at > 1 ORDER BY member_id").all<{ member_id: string }>()).results.map(
    (row) => row.member_id,
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM registrations");
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("refreshing every installed pass", () => {
  beforeEach(async () => {
    // An Apple device registered for the pass.
    await insertMember("BC-1", "apple@example.com");
    await env.DB.prepare("INSERT INTO devices (device_library_identifier, push_token) VALUES ('device-1', 'push-1')").run();
    await env.DB.prepare(
      "INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES ('device-1', 'pass.example', 'BC-1')",
    ).run();
    // Signed in here, by address, or by a claimed membership.
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (10, 'signedin@example.com', 0), (11, 'claimer@example.com', 0)").run();
    await insertMember("BC-2", "signedin@example.com");
    await insertMember("BC-3", "relay@example.com", 11);
    // Emailed a card.
    await insertMember("BC-4", "emailed@example.com");
    await env.DB.prepare("INSERT INTO audit_log (action, subject_email, detail) VALUES ('card.emailed', 'emailed@example.com', 'x')").run();
    // None of those: nothing installed to refresh.
    await insertMember("BC-5", "nothing@example.com");
    // Revoked, and expelled, though both signed in.
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (12, 'revoked@example.com', 0), (13, 'expelled@example.com', 0)").run();
    await insertMember("BC-6", "revoked@example.com");
    await insertMember("BC-7", "expelled@example.com");
    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('BC-6')").run();
    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES ('expelled@example.com')").run();
  });

  it("refreshes everyone who could have a pass installed, and nobody else", async () => {
    expect(await refreshInstalledPasses(env, { audience: "everyone" })).toBeNull();

    expect(await refreshedIds()).toEqual(["BC-1", "BC-2", "BC-3", "BC-4"]);
  });

  it("refreshes only admins' own cards in the first stage", async () => {
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = 11").run();

    await refreshInstalledPasses(env, { audience: "admins" });

    expect(await refreshedIds()).toEqual(["BC-3"]);
  });

  it("changes nothing when a batch is delivered again, since everyone in it is already newer than the run", async () => {
    const startedAt = Date.now();
    await refreshInstalledPasses(env, { audience: "everyone", startedAt });
    const after = await env.DB.prepare("SELECT member_id, last_updated_at FROM members ORDER BY member_id").all();

    await refreshInstalledPasses(env, { audience: "everyone", startedAt });

    expect((await env.DB.prepare("SELECT member_id, last_updated_at FROM members ORDER BY member_id").all()).results).toEqual(after.results);
  });

  it("emails nobody", async () => {
    const send = vi.fn();
    env.EMAIL = { send } as unknown as typeof env.EMAIL;
    await refreshInstalledPasses(env, { audience: "everyone" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a refresh larger than one batch", () => {
  it("carries on in batches, counting as it goes", async () => {
    const total = PASS_REFRESH_BATCH + 7;
    await env.DB.prepare("INSERT INTO users (id, email) VALUES (20, 'unused@example.com')").run();
    for (let i = 0; i < total; i++) {
      const email = `member${i}@example.com`;
      await insertMember(`BC-${String(i).padStart(3, "0")}`, email);
      await env.DB.prepare("INSERT INTO audit_log (action, subject_email, detail) VALUES ('card.emailed', ?, 'x')").bind(email).run();
    }

    const first = (await refreshInstalledPasses(env, { audience: "everyone" })) as PassRefreshCursor;
    expect(first).toMatchObject({ audience: "everyone", afterMemberId: `BC-${String(PASS_REFRESH_BATCH - 1).padStart(3, "0")}`, refreshed: PASS_REFRESH_BATCH });
    expect(await refreshInstalledPasses(env, first)).toBeNull();
    expect(await refreshedIds()).toHaveLength(total);
  });
});
