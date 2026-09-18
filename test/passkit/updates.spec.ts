import "../setup/d1";
import { env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderTokenCache } from "../../src/passkit/apns";
import { notifyPassUpdated } from "../../src/passkit/updates";

const PASS_TYPE_ID = "pass.es.losverd.card";
let privateKeyPem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKeyPem = await exportPKCS8(pair.privateKey);
});

beforeEach(() => {
  env.PASSKIT_PASS_TYPE_IDENTIFIER = PASS_TYPE_ID;
  env.PASSKIT_TEAM_IDENTIFIER = "KJHZP635V9";
  env.APNS_KEY_ID = "ABC123DEFG";
  env.APNS_PRIVATE_KEY_PEM = privateKeyPem;
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetProviderTokenCache();
  await env.DB.exec("DELETE FROM registrations");
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM members");
});

async function seedMember(memberId: string) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'token', 1)`,
  )
    .bind(memberId, `${memberId.toLowerCase()}@example.com`)
    .run();
}

async function register(device: string, pushToken: string, serial: string, passType = PASS_TYPE_ID) {
  await env.DB.prepare(
    "INSERT INTO devices (device_library_identifier, push_token) VALUES (?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(device, pushToken)
    .run();
  await env.DB.prepare(
    "INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES (?, ?, ?)",
  )
    .bind(device, passType, serial)
    .run();
}

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())!.n;
}

/** Routes mocked APNs responses by push token (the last URL path segment). */
function mockApnsByToken(responses: Record<string, Response | Error>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const token = String(input).split("/").pop()!;
    const response = responses[token];
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("notifyPassUpdated", () => {
  it("skips (without querying or pushing) when APNs isn't configured", async () => {
    env.APNS_KEY_ID = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await notifyPassUpdated(env, "LV-1")).toEqual({
      skipped: true,
      sent: 0,
      unregistered: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips when only the private key is missing", async () => {
    env.APNS_PRIVATE_KEY_PEM = "";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await notifyPassUpdated(env, "LV-1")).skipped).toBe(true);
  });

  it("pushes to every device registered for this serial and pass type, and nothing else", async () => {
    await seedMember("LV-1");
    await seedMember("LV-2");
    await register("device-a", "token-a", "LV-1");
    await register("device-b", "token-b", "LV-1");
    await register("device-c", "token-c", "LV-2"); // different member
    await register("device-d", "token-d", "LV-1", "pass.other.type"); // different pass type
    const fetchSpy = mockApnsByToken({
      "token-a": new Response(null, { status: 200 }),
      "token-b": new Response(null, { status: 200 }),
    });

    expect(await notifyPassUpdated(env, "LV-1")).toEqual({
      skipped: false,
      sent: 2,
      unregistered: 0,
      failed: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("removes devices APNs reports as unregistered, cascading to their registrations", async () => {
    await seedMember("LV-1");
    await register("device-gone", "token-gone", "LV-1");
    await register("device-ok", "token-ok", "LV-1");
    mockApnsByToken({
      "token-gone": new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }),
      "token-ok": new Response(null, { status: 200 }),
    });

    const summary = await notifyPassUpdated(env, "LV-1");

    expect(summary).toMatchObject({ sent: 1, unregistered: 1, failed: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE device_library_identifier = 'device-gone'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM registrations WHERE device_library_identifier = 'device-gone'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM registrations")).toBe(1);
  });

  it("counts and logs failures (including thrown fetch errors) without throwing or removing devices", async () => {
    await seedMember("LV-1");
    await register("device-500", "token-500", "LV-1");
    await register("device-throw", "token-throw", "LV-1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApnsByToken({
      "token-500": new Response(JSON.stringify({ reason: "InternalServerError" }), { status: 500 }),
      "token-throw": new Error("network down"),
    });

    const summary = await notifyPassUpdated(env, "LV-1");

    expect(summary).toMatchObject({ sent: 0, unregistered: 0, failed: 2 });
    expect(error).toHaveBeenCalledTimes(2);
    expect(await count("SELECT COUNT(*) AS n FROM devices")).toBe(2);
  });

  it("does nothing for a pass with no registered devices", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await notifyPassUpdated(env, "LV-none")).toMatchObject({ sent: 0, skipped: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
