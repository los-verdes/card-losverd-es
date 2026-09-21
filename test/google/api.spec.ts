import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WALLET_API,
  getGoogleWalletAccessToken,
  resetGoogleWalletTokenCache,
  updateGenericObjectIfPresent,
  upsertGenericObject,
} from "../../src/google/api";
import { buildGenericObject, googleWalletConfig, type MemberWalletInput } from "../../src/google/jwt";
import { fakeGoogleWallet } from "./fake";

const MEMBER: MemberWalletInput = {
  memberId: "LV-00000000-0000-4000-8000-000000000001",
  firstName: "Sam",
  lastName: "Rivera",
  status: "active",
  expirationDate: "2099-01-01",
  memberSince: "2021-07-01",
  verifyUrl: "https://card.example.test/verify-pass/LV-00000000-0000-4000-8000-000000000001?signature=x",
};
const CONFIG = googleWalletConfig({
  issuerId: "3388000000000000000",
  classSuffix: "test_class",
  baseUrl: "https://card.example.test",
});

let credentials: { serviceAccountEmail: string; privateKeyPem: string };

interface Call {
  method: string;
  url: string;
  body: string | null;
  authorization: string | null;
}

/** Fakes Google's token endpoint and object endpoints; records every call. */
function mockGoogle(options: { insertStatus?: number; updateStatus?: number; tokenStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null,
      authorization: headers.get("Authorization"),
    });
    if (url === GOOGLE_OAUTH_TOKEN_URL) {
      const status = options.tokenStatus ?? 200;
      return status === 200
        ? Response.json({ access_token: `token-${calls.length}` })
        : new Response("invalid_grant", { status });
    }
    if (url === `${GOOGLE_WALLET_API}/genericObject`) {
      const status = options.insertStatus ?? 200;
      return new Response(status === 200 ? "{}" : `{"error":{"code":${status}}}`, { status });
    }
    if (url.startsWith(`${GOOGLE_WALLET_API}/genericObject/`)) {
      const status = options.updateStatus ?? 200;
      return new Response(status === 200 ? "{}" : "nope", { status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

beforeEach(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  credentials = {
    serviceAccountEmail: "wallet@example.iam.gserviceaccount.com",
    privateKeyPem: await exportPKCS8(privateKey),
  };
  resetGoogleWalletTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGoogleWalletAccessToken", () => {
  it("exchanges a signed JWT-bearer assertion for a token", async () => {
    const calls = mockGoogle();

    const token = await getGoogleWalletAccessToken(credentials, 1_800_000_000);

    expect(token).toBe("token-1");
    const [call] = calls;
    expect(call.method).toBe("POST");
    const form = new URLSearchParams(call.body!);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = decodeJwt(form.get("assertion")!);
    expect(assertion).toMatchObject({
      iss: credentials.serviceAccountEmail,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      scope: "https://www.googleapis.com/auth/wallet_object.issuer",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
    });
  });

  it("reuses the token within an isolate, and refreshes it after fifty minutes or a credential change", async () => {
    const calls = mockGoogle();
    const t0 = 1_800_000_000;

    expect(await getGoogleWalletAccessToken(credentials, t0)).toBe("token-1");
    expect(await getGoogleWalletAccessToken(credentials, t0 + 49 * 60)).toBe("token-1");
    expect(calls).toHaveLength(1);

    expect(await getGoogleWalletAccessToken(credentials, t0 + 51 * 60)).toBe("token-2");
    expect(
      await getGoogleWalletAccessToken({ ...credentials, serviceAccountEmail: "other@example.iam.gserviceaccount.com" }, t0 + 51 * 60),
    ).toBe("token-3");
    expect(calls).toHaveLength(3);
  });

  it("throws on a rejected exchange, with the status but not the whole body", async () => {
    mockGoogle({ tokenStatus: 400 });

    await expect(getGoogleWalletAccessToken(credentials)).rejects.toThrow("token exchange failed: 400 invalid_grant");
  });

  it("throws when the response carries no token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

    await expect(getGoogleWalletAccessToken(credentials)).rejects.toThrow("no access_token");
  });
});

describe("upsertGenericObject", () => {
  const object = buildGenericObject(MEMBER, CONFIG);

  it("inserts a new object with the bearer token", async () => {
    const calls = mockGoogle();

    expect(await upsertGenericObject(credentials, object)).toBe("inserted");

    const insert = calls[1];
    expect(insert.method).toBe("POST");
    expect(insert.url).toBe(`${GOOGLE_WALLET_API}/genericObject`);
    expect(insert.authorization).toBe("Bearer token-1");
    expect(JSON.parse(insert.body!)).toEqual(object);
    expect(calls).toHaveLength(2);
  });

  it("updates in place when Google says the object already exists", async () => {
    const calls = mockGoogle({ insertStatus: 409 });

    expect(await upsertGenericObject(credentials, object)).toBe("updated");

    const update = calls[2];
    expect(update.method).toBe("PUT");
    expect(update.url).toBe(`${GOOGLE_WALLET_API}/genericObject/${encodeURIComponent(object.id)}`);
    expect(JSON.parse(update.body!)).toEqual(object);
  });

  it("throws on any other insert failure, quoting Google's error", async () => {
    mockGoogle({ insertStatus: 400 });

    await expect(upsertGenericObject(credentials, object)).rejects.toThrow('insert failed: 400 {"error":{"code":400}}');
  });

  it("throws when the update after a conflict fails", async () => {
    mockGoogle({ insertStatus: 409, updateStatus: 500 });

    await expect(upsertGenericObject(credentials, object)).rejects.toThrow("update failed: 500 nope");
  });
});

describe("updateGenericObjectIfPresent", () => {
  const object = buildGenericObject(MEMBER, CONFIG);

  it("updates an object Google already has, without inserting", async () => {
    const calls = mockGoogle();

    expect(await updateGenericObjectIfPresent(credentials, object)).toBe("updated");

    const update = calls[1];
    expect(update.method).toBe("PUT");
    expect(update.url).toBe(`${GOOGLE_WALLET_API}/genericObject/${encodeURIComponent(object.id)}`);
    expect(JSON.parse(update.body!)).toEqual(object);
    // The token exchange and the PUT, and nothing else: no POST.
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/genericObject"))).toBe(false);
  });

  it("does nothing for a member who has never saved a pass", async () => {
    // This is the guard that keeps a full resync from minting a Wallet
    // object for every member on the roll.
    const calls = mockGoogle({ updateStatus: 404 });

    expect(await updateGenericObjectIfPresent(credentials, object)).toBe("absent");

    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/genericObject"))).toBe(false);
  });

  it("throws on any other failure, quoting Google's error", async () => {
    mockGoogle({ updateStatus: 500 });

    await expect(updateGenericObjectIfPresent(credentials, object)).rejects.toThrow("update failed: 500 nope");
  });
});

describe("fakeGoogleWallet (test helper)", () => {
  it("fails a spec that reaches anything but Google", () => {
    expect(() => fakeGoogleWallet("https://example.test/other")).toThrow("unexpected fetch");
  });
});
