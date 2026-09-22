import "../setup/d1";
import { env, SELF } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { getTestCertChain } from "../fixtures/certChain";
import {
  LOG_RATE_LIMIT,
  MAX_LOG_ENTRIES,
  MAX_LOG_MESSAGE_LENGTH,
} from "../../src/passkit/routes";

const PASS_TYPE_ID = "pass.es.losverd.card";
const BASE = "https://example.com/passkit";

interface SeedMemberOptions {
  memberId?: string;
  authToken?: string;
  expirationDate?: string;
  lastUpdatedAt?: number;
}

async function seedMember(options: SeedMemberOptions = {}) {
  const memberId = options.memberId ?? "LV-10023";
  const authToken = options.authToken ?? "test-auth-token";
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      memberId,
      "Jane",
      "Doe",
      `${memberId.toLowerCase()}@example.com`,
      options.expirationDate ?? "2027-01-15",
      "2021-07-15",
      authToken,
      options.lastUpdatedAt ?? Date.now(),
    )
    .run();
  return { memberId, authToken };
}

async function seedTemplateAssets() {
  for (const name of ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"]) {
    await env.ASSETS.put(`templates/apple/${name}`, new Uint8Array([1, 2, 3]));
  }
}

beforeEach(() => {
  const chain = getTestCertChain();
  env.PASSKIT_PASS_TYPE_IDENTIFIER = PASS_TYPE_ID;
  env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
  env.PASSKIT_ORGANIZATION_NAME = "Los Verdes";
  env.PASSKIT_WEB_SERVICE_URL = "https://card.losverd.es/passkit";
  env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
  env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
  env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM registrations");
  await env.DB.exec("DELETE FROM devices");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM pass_device_logs");
});

describe("POST /v1/devices/.../registrations/...", () => {
  const path = (deviceId: string, memberId: string) =>
    `${BASE}/v1/devices/${deviceId}/registrations/${PASS_TYPE_ID}/${memberId}`;

  it("rejects a request with no Authorization header", async () => {
    const { memberId } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "POST",
      body: JSON.stringify({ pushToken: "push-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong auth token", async () => {
    const { memberId } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "POST",
      headers: { authorization: "ApplePass wrong-token" },
      body: JSON.stringify({ pushToken: "push-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request for an unknown member", async () => {
    const res = await SELF.fetch(path("device-1", "LV-NOPE"), {
      method: "POST",
      headers: { authorization: "ApplePass anything" },
      body: JSON.stringify({ pushToken: "push-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a body missing pushToken", async () => {
    const { memberId, authToken } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "POST",
      headers: { authorization: `ApplePass ${authToken}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const { memberId, authToken } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "POST",
      headers: { authorization: `ApplePass ${authToken}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 201 for a new device/pass registration", async () => {
    const { memberId, authToken } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "POST",
      headers: { authorization: `ApplePass ${authToken}` },
      body: JSON.stringify({ pushToken: "push-1" }),
    });
    expect(res.status).toBe(201);

    const registration = await env.DB.prepare(
      "SELECT * FROM registrations WHERE device_library_identifier = ? AND serial_number = ?",
    )
      .bind("device-1", memberId)
      .first();
    expect(registration).not.toBeNull();
  });

  it("returns 200 when the device/pass registration already exists", async () => {
    const { memberId, authToken } = await seedMember();
    const req = () =>
      SELF.fetch(path("device-1", memberId), {
        method: "POST",
        headers: { authorization: `ApplePass ${authToken}` },
        body: JSON.stringify({ pushToken: "push-1" }),
      });

    expect((await req()).status).toBe(201);
    expect((await req()).status).toBe(200);
  });

  it("upserts the device's push token on re-registration", async () => {
    const { memberId, authToken } = await seedMember();
    const register = (pushToken: string) =>
      SELF.fetch(path("device-1", memberId), {
        method: "POST",
        headers: { authorization: `ApplePass ${authToken}` },
        body: JSON.stringify({ pushToken }),
      });

    await register("push-1");
    await register("push-2");

    const device = await env.DB.prepare(
      "SELECT push_token FROM devices WHERE device_library_identifier = ?",
    )
      .bind("device-1")
      .first<{ push_token: string }>();
    expect(device?.push_token).toBe("push-2");
  });
});

describe("GET /v1/devices/.../registrations/:passTypeIdentifier", () => {
  const path = (deviceId: string, query = "") =>
    `${BASE}/v1/devices/${deviceId}/registrations/${PASS_TYPE_ID}${query}`;

  async function registerDevice(deviceId: string, memberId: string) {
    await env.DB.prepare(
      `INSERT INTO devices (device_library_identifier, push_token) VALUES (?, 'push')`,
    )
      .bind(deviceId)
      .run();
    await env.DB.prepare(
      `INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES (?, ?, ?)`,
    )
      .bind(deviceId, PASS_TYPE_ID, memberId)
      .run();
  }

  it("returns 204 for a device with no registrations", async () => {
    const res = await SELF.fetch(path("device-unknown"));
    expect(res.status).toBe(204);
  });

  it("returns 200 with the registered serial numbers when no passesUpdatedSince is given", async () => {
    const { memberId } = await seedMember({ lastUpdatedAt: 1000 });
    await registerDevice("device-1", memberId);

    const res = await SELF.fetch(path("device-1"));
    expect(res.status).toBe(200);
    const body = await res.json<{ lastUpdated: string; serialNumbers: string[] }>();
    expect(body.serialNumbers).toEqual([memberId]);
    expect(body.lastUpdated).toBe("1000");
  });

  it("returns 204 when passesUpdatedSince is after the member's last update", async () => {
    const { memberId } = await seedMember({ lastUpdatedAt: 1000 });
    await registerDevice("device-1", memberId);

    const res = await SELF.fetch(path("device-1", "?passesUpdatedSince=999999999999"));
    expect(res.status).toBe(204);
  });

  it("returns 200 when passesUpdatedSince is before the member's last update", async () => {
    const { memberId } = await seedMember({ lastUpdatedAt: 5000 });
    await registerDevice("device-1", memberId);

    const res = await SELF.fetch(path("device-1", "?passesUpdatedSince=1000"));
    expect(res.status).toBe(200);
    const body = await res.json<{ serialNumbers: string[] }>();
    expect(body.serialNumbers).toEqual([memberId]);
  });
});

describe("GET /v1/passes/:passTypeIdentifier/:serialNumber", () => {
  const path = (memberId: string) => `${BASE}/v1/passes/${PASS_TYPE_ID}/${memberId}`;

  it("rejects a request with an invalid auth token", async () => {
    const { memberId } = await seedMember({ memberId: "LV-30001" });
    const res = await SELF.fetch(path(memberId), {
      headers: { authorization: "ApplePass wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 304 when If-Modified-Since matches the member's last update", async () => {
    const lastUpdatedAt = Date.now();
    const { memberId, authToken } = await seedMember({
      memberId: "LV-30002",
      lastUpdatedAt,
    });

    const res = await SELF.fetch(path(memberId), {
      headers: {
        authorization: `ApplePass ${authToken}`,
        "if-modified-since": new Date(lastUpdatedAt + 1000).toUTCString(),
      },
    });
    expect(res.status).toBe(304);
  });

  it("returns 304 when the device echoes back the Last-Modified it was given", async () => {
    // HTTP dates carry seconds, so the header the device sends back is the
    // record's time with the milliseconds dropped. Comparing it against the
    // full millisecond value made the pass look newer than itself, and Wallet
    // reported being handed a pass identical to the one it held (staging,
    // 2026-09-22).
    const lastUpdatedAt = Date.now();
    const withMilliseconds = lastUpdatedAt % 1000 === 0 ? lastUpdatedAt + 400 : lastUpdatedAt;
    const { memberId, authToken } = await seedMember({ memberId: "LV-30004", lastUpdatedAt: withMilliseconds });

    const res = await SELF.fetch(path(memberId), {
      headers: {
        authorization: `ApplePass ${authToken}`,
        // Exactly what the previous response's Last-Modified said.
        "if-modified-since": new Date(withMilliseconds).toUTCString(),
      },
    });

    expect(res.status).toBe(304);
  });

  it("fails loudly rather than serving a broken pass when template assets are missing from R2", async () => {
    // No seedTemplateAssets() call -- matches a not-yet-provisioned R2
    // bucket (Phase 3.2's asset migration script hasn't run).
    const { memberId, authToken } = await seedMember({ memberId: "LV-30005" });

    const res = await SELF.fetch(path(memberId), {
      headers: { authorization: `ApplePass ${authToken}` },
    });

    expect(res.status).toBe(500);
  });

  it("ignores an unparseable If-Modified-Since header rather than treating it as a match", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({ memberId: "LV-30006" });

    const res = await SELF.fetch(path(memberId), {
      headers: {
        authorization: `ApplePass ${authToken}`,
        "if-modified-since": "not a date",
      },
    });

    expect(res.status).toBe(200);
  });

  it("marks a lapsed membership expired even when nothing has synced since", async () => {
    // Nothing stores "expired": a membership lapses because a date passes,
    // with no sync to notice. The pass Apple fetches works it out when built.
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({
      memberId: "LV-30007",
      expirationDate: "2020-01-15",
    });

    const res = await SELF.fetch(path(memberId), {
      headers: { authorization: `ApplePass ${authToken}` },
    });

    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const pass = JSON.parse(strFromU8(files["pass.json"]));
    const statusField = pass.generic.backFields.find(
      (field: { key: string }) => field.key === "status",
    );
    expect(statusField?.value).toBe("Expired");
  });

  it("returns a signed .pkpass bundle on a cache miss, and caches it", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({ memberId: "LV-30003" });

    const res = await SELF.fetch(path(memberId), {
      headers: { authorization: `ApplePass ${authToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.pkpass");
    expect(res.headers.get("last-modified")).toBeTruthy();

    const bundle = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(bundle);
    expect(Object.keys(files).sort()).toEqual([
      "icon.png",
      "icon@2x.png",
      "logo.png",
      "logo@2x.png",
      "manifest.json",
      "pass.json",
      "signature",
    ]);
    const passJson = JSON.parse(new TextDecoder().decode(files["pass.json"]));
    expect(passJson.serialNumber).toBe(memberId);
  });

  it("serves from the R2 cache on a second request, without needing template assets again", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({ memberId: "LV-30004" });
    const headers = { authorization: `ApplePass ${authToken}` };

    const first = await SELF.fetch(path(memberId), { headers });
    expect(first.status).toBe(200);

    // Remove the template assets: a second request would fail if it needed
    // to rebuild the bundle, so a 200 here proves the cache path was taken.
    for (const name of ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"]) {
      await env.ASSETS.delete(`templates/apple/${name}`);
    }

    const second = await SELF.fetch(path(memberId), { headers });
    expect(second.status).toBe(200);
  });

  it("regenerates instead of serving a stale cached pass once the member has been updated", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({
      memberId: "LV-30005",
      lastUpdatedAt: 1_000,
    });
    const headers = { authorization: `ApplePass ${authToken}` };
    expect((await SELF.fetch(path(memberId), { headers })).status).toBe(200);

    await env.DB.prepare(
      "UPDATE members SET last_name = 'Doe-Smith', last_updated_at = 2000 WHERE member_id = ?",
    )
      .bind(memberId)
      .run();

    const res = await SELF.fetch(path(memberId), { headers });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const passJson = JSON.parse(new TextDecoder().decode(files["pass.json"]));
    expect(JSON.stringify(passJson)).toContain("Doe-Smith");
  });
});

describe("DELETE /v1/devices/.../registrations/...", () => {
  const path = (deviceId: string, memberId: string) =>
    `${BASE}/v1/devices/${deviceId}/registrations/${PASS_TYPE_ID}/${memberId}`;

  it("rejects a request with an invalid auth token", async () => {
    const { memberId } = await seedMember();
    const res = await SELF.fetch(path("device-1", memberId), {
      method: "DELETE",
      headers: { authorization: "ApplePass wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 and removes the registration from D1", async () => {
    const { memberId, authToken } = await seedMember();
    await env.DB.prepare(
      `INSERT INTO devices (device_library_identifier, push_token) VALUES ('device-1', 'push')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO registrations (device_library_identifier, pass_type_identifier, serial_number) VALUES ('device-1', ?, ?)`,
    )
      .bind(PASS_TYPE_ID, memberId)
      .run();

    const res = await SELF.fetch(path("device-1", memberId), {
      method: "DELETE",
      headers: { authorization: `ApplePass ${authToken}` },
    });
    expect(res.status).toBe(200);

    const remaining = await env.DB.prepare(
      "SELECT 1 FROM registrations WHERE device_library_identifier = ? AND serial_number = ?",
    )
      .bind("device-1", memberId)
      .first();
    expect(remaining).toBeNull();
  });
});

describe("POST /v1/log", () => {
  const path = `${BASE}/v1/log`;

  it("accepts a logs array and stores each message", async () => {
    const res = await SELF.fetch(path, {
      method: "POST",
      body: JSON.stringify({ logs: ["pass validation failed", "signature mismatch"] }),
    });
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT message FROM pass_device_logs ORDER BY id",
    ).all<{ message: string }>();
    expect(results.map((r) => r.message)).toEqual([
      "pass validation failed",
      "signature mismatch",
    ]);
  });

  it("rejects invalid JSON", async () => {
    const res = await SELF.fetch(path, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("tolerates a missing/malformed logs field (treats as empty)", async () => {
    const res = await SELF.fetch(path, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(200);
  });

  // This endpoint cannot be authenticated -- Apple's devices post to it when
  // something, possibly auth itself, is already broken -- so it is the one
  // place anyone at all can write rows through. Each bound below is what
  // stops that being interesting to abuse.
  it("stores only the first MAX_LOG_ENTRIES of an oversized batch", async () => {
    const logs = Array.from({ length: MAX_LOG_ENTRIES + 25 }, (_, i) => `entry ${i}`);

    const res = await SELF.fetch(path, { method: "POST", body: JSON.stringify({ logs }) });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pass_device_logs").first<{ n: number }>();
    expect(row?.n).toBe(MAX_LOG_ENTRIES);
  });

  it("truncates a message rather than storing a payload", async () => {
    const res = await SELF.fetch(path, {
      method: "POST",
      body: JSON.stringify({ logs: ["x".repeat(MAX_LOG_MESSAGE_LENGTH + 5_000)] }),
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT message FROM pass_device_logs").first<{ message: string }>();
    expect(row?.message.length).toBe(MAX_LOG_MESSAGE_LENGTH);
  });

  it("stops storing once a caller exceeds the rate limit, still answering 200", async () => {
    // 200 either way on purpose: a device that has just failed at something
    // is not helped by a rejection, and Apple would only retry it.
    for (let i = 0; i < LOG_RATE_LIMIT.limit + 3; i++) {
      const res = await SELF.fetch(path, {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ logs: [`entry ${i}`] }),
      });
      expect(res.status).toBe(200);
    }

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pass_device_logs").first<{ n: number }>();
    expect(row?.n).toBe(LOG_RATE_LIMIT.limit);
  });
});

describe("member_since overrides on issued passes", () => {
  it("shows a member_since_overrides date instead of the order-derived one", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({ memberId: "LV-40001" }); // members.member_since = 2021-07-15
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('lv-40001@example.com', '2016-03-01', 'manual')",
    ).run();

    const res = await SELF.fetch(`${BASE}/v1/passes/${PASS_TYPE_ID}/${memberId}`, {
      headers: { authorization: `ApplePass ${authToken}` },
    });

    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const passJson = JSON.stringify(JSON.parse(new TextDecoder().decode(files["pass.json"])));
    expect(passJson).toContain("Mar 2016");
    expect(passJson).not.toContain("Jul 2021");
    await env.DB.exec("DELETE FROM member_since_overrides");
  });
});

describe("pass QR code", () => {
  it("encodes a signed /verify-pass URL that the verification page accepts", async () => {
    await seedTemplateAssets();
    const { memberId, authToken } = await seedMember({ memberId: "LV-50001" });

    const res = await SELF.fetch(`${BASE}/v1/passes/${PASS_TYPE_ID}/${memberId}`, {
      headers: { authorization: `ApplePass ${authToken}` },
    });
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const { barcode } = JSON.parse(new TextDecoder().decode(files["pass.json"]));

    const verifyUrl = new URL(barcode.message);
    expect(verifyUrl.origin + verifyUrl.pathname).toBe(`https://card.losverd.es/verify-pass/${memberId}`);

    env.SESSION_SIGNING_KEY = "test-session-signing-key-0123456789";
    const session = await issueSessionToken(env.SESSION_SIGNING_KEY, { userId: 1, isAdmin: false });
    const verification = await SELF.fetch(`https://example.com${verifyUrl.pathname}${verifyUrl.search}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session}` },
    });
    expect(verification.status).toBe(200);
    expect(await verification.text()).toContain("MEMBERSHIP VALID");
  });
});
