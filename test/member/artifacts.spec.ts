import { env } from "cloudflare:test";
import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassSerialSignature } from "../../src/lib/passSignature";
import {
  buildGoogleWalletSaveUrl,
  getMemberByEmail,
  getMemberById,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "../../src/member/artifacts";
import LOGO from "../fixtures/sample-logo.png";
import { GOOGLE_WALLET_API, resetGoogleWalletTokenCache } from "../../src/google/api";
import { fakeGoogleWallet } from "../google/fake";

const PASS_KEY = "test-pass-signature-key".repeat(5);

beforeEach(() => {
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = PASS_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetGoogleWalletTokenCache();
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.ASSETS.delete("templates/card/crest.png");
});

async function insertMember(memberId = "BC-1", email = "jane@example.com") {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'standard', 'active', '2099-01-15', '2024-01-15', 'token', 1)`,
  )
    .bind(memberId, email)
    .run();
}

describe("member lookups", () => {
  it("find a member by id or (case-insensitive, trimmed) email", async () => {
    await insertMember();

    expect((await getMemberById(env, "BC-1"))?.email).toBe("jane@example.com");
    expect((await getMemberByEmail(env, "  Jane@Example.COM "))?.member_id).toBe("BC-1");
    expect(await getMemberById(env, "BC-404")).toBeNull();
    expect(await getMemberByEmail(env, "nobody@example.com")).toBeNull();
  });

  it("apply a member_since override over the order-derived date", async () => {
    await insertMember();
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('jane@example.com', '2016-03-01', 'manual')",
    ).run();

    expect((await getMemberById(env, "BC-1"))?.member_since).toBe("2016-03-01");
    expect((await getMemberByEmail(env, "jane@example.com"))?.member_since).toBe("2016-03-01");
  });
});

describe("isMembershipCurrent", () => {
  it.each<[string, Pick<MemberRecord, "status" | "expiration_date">, boolean]>([
    ["unexpired", { status: "active", expiration_date: "2026-09-16" }, true],
    ["stale 'expired' status but renewed date", { status: "expired", expiration_date: "2027-01-01" }, true],
    ["lapsed despite 'active' status", { status: "active", expiration_date: "2026-09-15" }, false],
    ["revoked", { status: "revoked", expiration_date: "2099-01-01" }, false],
    ["no expiration on record", { status: "active", expiration_date: null }, false],
  ])("%s -> %s", (_label, member, expected) => {
    expect(isMembershipCurrent(member, "2026-09-16")).toBe(expected);
  });

  it("defaults to today", () => {
    expect(isMembershipCurrent({ status: "active", expiration_date: "2099-01-01" })).toBe(true);
  });
});

describe("renderCardImage", () => {
  it("fails loudly when the crest isn't in R2", async () => {
    await insertMember();
    const member = (await getMemberById(env, "BC-1"))!;
    await expect(renderCardImage(env, member)).rejects.toThrow(/templates\/card\/crest\.png.*just r2-upload-templates/);
  });

  it("renders a PNG using the R2 crest", async () => {
    await insertMember();
    await env.ASSETS.put("templates/card/crest.png", new Uint8Array(LOGO));
    const png = await renderCardImage(env, (await getMemberById(env, "BC-1"))!);
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("buildGoogleWalletSaveUrl", () => {
  it("fails closed when Google Wallet credentials aren't configured", async () => {
    await insertMember();
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
    await expect(buildGoogleWalletSaveUrl(env, (await getMemberById(env, "BC-1"))!)).rejects.toThrow(
      /not configured/,
    );
  });

  it("writes the object to Google, then links to it by id, with a verifiable QR URL in the object", async () => {
    await insertMember();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
    env.GOOGLE_WALLET_ISSUER_ID = "3388000000022031577";
    env.GOOGLE_WALLET_CLASS_SUFFIX = "los_verdes_member_v1";
    const written: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${GOOGLE_WALLET_API}/genericObject`) written.push(JSON.parse(init!.body as string));
      return fakeGoogleWallet(url);
    });

    const url = await buildGoogleWalletSaveUrl(env, (await getMemberById(env, "BC-1"))!);

    // The link is the skinny form: envelope plus the object's id only.
    expect(url.startsWith("https://pay.google.com/gp/v/save/")).toBe(true);
    expect(url.length).toBeLessThan(1800);
    const claims = decodeJwt(url.slice("https://pay.google.com/gp/v/save/".length)) as {
      iss: string;
      typ: string;
      iat: number;
      origins: string[];
      payload: { genericObjects: { id: string }[] };
    };
    expect(claims.iss).toBe("wallet@example.iam.gserviceaccount.com");
    expect(claims.typ).toBe("savetowallet");
    expect(typeof claims.iat).toBe("number");
    expect(claims.origins).toEqual(["https://card.losverd.es"]);
    expect(claims.payload.genericObjects).toEqual([{ id: "3388000000022031577.BC-1" }]);

    // The full object went to Google's API instead.
    expect(written).toHaveLength(1);
    const object = written[0] as { id: string; classId: string; barcode: { value: string } };
    expect(object.id).toBe("3388000000022031577.BC-1");
    expect(object.classId).toBe("3388000000022031577.los_verdes_member_v1");
    const qr = new URL(object.barcode.value);
    expect(await verifyPassSerialSignature(PASS_KEY, "BC-1", qr.searchParams.get("signature")!)).toBe(true);
  });

  it("fails, so callers fall back, when Google rejects the object", async () => {
    await insertMember();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${GOOGLE_WALLET_API}/genericObject`) return new Response("bad object", { status: 400 });
      return fakeGoogleWallet(url);
    });

    await expect(buildGoogleWalletSaveUrl(env, (await getMemberById(env, "BC-1"))!)).rejects.toThrow("insert failed: 400");
  });
});
