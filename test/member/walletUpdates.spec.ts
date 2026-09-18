import { env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WALLET_API,
  resetGoogleWalletTokenCache,
} from "../../src/google/api";
import { notifyWalletsUpdated } from "../../src/member/walletUpdates";

const MEMBER_ID = "LV-00000000-0000-4000-8000-000000000001";

interface Call {
  method: string;
  url: string;
}

/** Google's two endpoints; `objectStatus` is what the PUT answers with. */
function mockGoogle(objectStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url === GOOGLE_OAUTH_TOKEN_URL) {
      return Response.json({ access_token: "token" });
    }
    if (url.startsWith(`${GOOGLE_WALLET_API}/genericObject`)) {
      return new Response(objectStatus === 200 ? "{}" : "nope", {
        status: objectStatus,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

async function insertMember(memberId = MEMBER_ID) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', 'jane@example.com', 'standard', 'active', '2099-01-15', '2024-01-15', 'token', 1)`,
  )
    .bind(memberId)
    .run();
}

const objectWrites = (calls: Call[]) =>
  calls.filter((call) => call.url.startsWith(`${GOOGLE_WALLET_API}/genericObject`));

beforeEach(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
  env.GOOGLE_WALLET_ISSUER_ID = "3388000000022031577";
  env.GOOGLE_WALLET_CLASS_SUFFIX = "los_verdes_member_v1";
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
  // APNs unconfigured: notifyPassUpdated() warns and skips, which keeps these
  // tests about the Google half.
  env.APNS_KEY_ID = undefined;
  env.APNS_PRIVATE_KEY_PEM = undefined;
  resetGoogleWalletTokenCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
  await env.DB.exec("DELETE FROM members");
});

describe("notifyWalletsUpdated", () => {
  it("writes the member's current details to the pass Google already holds", async () => {
    await insertMember();
    const calls = mockGoogle();

    await notifyWalletsUpdated(env, MEMBER_ID);

    const [write] = objectWrites(calls);
    expect(write.method).toBe("PUT");
    expect(write.url).toBe(
      `${GOOGLE_WALLET_API}/genericObject/${encodeURIComponent(`3388000000022031577.${MEMBER_ID}`)}`,
    );
  });

  it("never creates a pass for a member who has not saved one", async () => {
    // The guard that matters: this runs once per changed member during a
    // resync, so inserting here would mint a pass for the whole roll.
    await insertMember();
    const calls = mockGoogle(404);

    await notifyWalletsUpdated(env, MEMBER_ID);

    expect(objectWrites(calls).map((call) => call.method)).toEqual(["PUT"]);
    expect(objectWrites(calls).some((call) => call.method === "POST")).toBe(false);
  });

  it("logs and carries on when Google fails, so a sync isn't lost to it", async () => {
    await insertMember();
    mockGoogle(500);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(notifyWalletsUpdated(env, MEMBER_ID)).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(
      "Google Wallet refresh failed",
      expect.objectContaining({ memberId: MEMBER_ID }),
    );
  });

  it("doesn't call Google at all when Google Wallet isn't configured", async () => {
    await insertMember();
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
    const calls = mockGoogle();

    await notifyWalletsUpdated(env, MEMBER_ID);

    expect(calls).toEqual([]);
  });

  it("does nothing for a member id that no longer exists", async () => {
    const calls = mockGoogle();

    await notifyWalletsUpdated(env, "LV-does-not-exist");

    expect(calls).toEqual([]);
  });
});
