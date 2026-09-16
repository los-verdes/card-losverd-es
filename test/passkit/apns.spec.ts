import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APNS_ORIGIN,
  getProviderToken,
  resetProviderTokenCache,
  sendPassUpdatePush,
  type ApnsConfig,
} from "../../src/passkit/apns";

let config: ApnsConfig;
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    teamId: "KJHZP635V9",
    keyId: "ABC123DEFG",
    privateKeyPem: await exportPKCS8(pair.privateKey),
    topic: "pass.es.losverd.card",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProviderTokenCache();
});

function mockApns(status: number, body?: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body ?? null, { status }));
}

describe("getProviderToken", () => {
  it("signs an ES256 JWT with the key id header and team id issuer", async () => {
    const token = await getProviderToken(config, 1_800_000_000);

    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    const { payload } = await jwtVerify(token, publicKey, {
      currentDate: new Date(1_800_000_000 * 1000),
    });
    expect(payload).toEqual({ iss: "KJHZP635V9", iat: 1_800_000_000 });
  });

  it("reuses the token for up to 40 minutes, then re-signs", async () => {
    const first = await getProviderToken(config, 1_800_000_000);
    expect(await getProviderToken(config, 1_800_000_000 + 39 * 60)).toBe(first);

    const refreshed = await getProviderToken(config, 1_800_000_000 + 40 * 60);
    expect(refreshed).not.toBe(first);
  });

  it("re-signs when the key id changes", async () => {
    const first = await getProviderToken(config, 1_800_000_000);
    const other = await getProviderToken({ ...config, keyId: "OTHERKEY99" }, 1_800_000_000);
    expect(other).not.toBe(first);
    expect(decodeProtectedHeader(other).kid).toBe("OTHERKEY99");
  });

  it("defaults to the current time", async () => {
    const token = await getProviderToken(config);
    await expect(jwtVerify(token, publicKey)).resolves.toBeTruthy();
  });
});

describe("sendPassUpdatePush", () => {
  it("POSTs an empty payload to the device on the pass type topic, with no push type", async () => {
    const fetchSpy = mockApns(200);

    await expect(sendPassUpdatePush(config, "abc123")).resolves.toEqual({ status: "sent" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${APNS_ORIGIN}/3/device/abc123`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const headers = init.headers as Record<string, string>;
    expect(headers["apns-topic"]).toBe("pass.es.losverd.card");
    expect(headers["apns-push-type"]).toBeUndefined();
    expect(headers.authorization).toMatch(/^bearer ey/);
  });

  it("URL-encodes the push token", async () => {
    const fetchSpy = mockApns(200);
    await sendPassUpdatePush(config, "a/b?c");
    expect(fetchSpy.mock.calls[0][0]).toBe(`${APNS_ORIGIN}/3/device/a%2Fb%3Fc`);
  });

  it("reports 410 as unregistered", async () => {
    mockApns(410, JSON.stringify({ reason: "Unregistered", timestamp: 1 }));
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "unregistered",
      reason: "Unregistered",
    });
  });

  it("reports a 410 with no body as unregistered", async () => {
    mockApns(410);
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "unregistered",
      reason: "Unregistered",
    });
  });

  it("reports 400 BadDeviceToken as unregistered", async () => {
    mockApns(400, JSON.stringify({ reason: "BadDeviceToken" }));
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "unregistered",
      reason: "BadDeviceToken",
    });
  });

  it("reports other 400s as failed", async () => {
    mockApns(400, JSON.stringify({ reason: "BadTopic" }));
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "failed",
      httpStatus: 400,
      reason: "BadTopic",
    });
  });

  it.each(["ExpiredProviderToken", "InvalidProviderToken"])(
    "drops the cached provider token after a 403 %s",
    async (reason) => {
      const before = await getProviderToken(config);
      mockApns(403, JSON.stringify({ reason }));

      await expect(sendPassUpdatePush(config, "t")).resolves.toMatchObject({ status: "failed", reason });

      expect(await getProviderToken(config)).not.toBe(before);
    },
  );

  it("keeps the cached provider token after an unrelated 403", async () => {
    const before = await getProviderToken(config);
    mockApns(403, JSON.stringify({ reason: "TopicDisallowed" }));

    await sendPassUpdatePush(config, "t");

    expect(await getProviderToken(config)).toBe(before);
  });

  it("tolerates a non-JSON or reason-less error body", async () => {
    mockApns(500, "<html>oops</html>");
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "failed",
      httpStatus: 500,
      reason: "",
    });

    vi.restoreAllMocks();
    mockApns(429, JSON.stringify({ reason: 42 }));
    await expect(sendPassUpdatePush(config, "t")).resolves.toEqual({
      status: "failed",
      httpStatus: 429,
      reason: "",
    });
  });
});
