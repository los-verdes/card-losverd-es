import "../setup/d1";
import { env } from "cloudflare:test";
import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassSerialSignature } from "../../src/lib/passSignature";
import {
  buildGoogleWalletSaveUrl,
  getMemberByEmail,
  getMemberById,
  effectiveStatus,
  getApplePassBundle,
  isMembershipCurrent,
  renderCardImage,
  type MemberRecord,
} from "../../src/member/artifacts";
import { unzipSync } from "fflate";
import LOGO from "../fixtures/sample-logo.png";
import BACKGROUND from "../fixtures/sample-card-background.png";
import { getTestCertChain } from "../fixtures/certChain";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
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
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, '2099-01-15', '2024-01-15', 'token', 1)`,
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
  it.each<[string, Pick<MemberRecord, "revoked" | "expiration_date">, boolean]>([
    ["good through today", { revoked: 0, expiration_date: "2026-09-16" }, true],
    ["good through a later date", { revoked: 0, expiration_date: "2027-01-01" }, true],
    ["lapsed yesterday", { revoked: 0, expiration_date: "2026-09-15" }, false],
    ["revoked", { revoked: 1, expiration_date: "2099-01-01" }, false],
    ["no expiration on record", { revoked: 0, expiration_date: null }, false],
  ])("%s -> %s", (_label, member, expected) => {
    expect(isMembershipCurrent(member, "2026-09-16")).toBe(expected);
  });

  it("defaults to today", () => {
    expect(isMembershipCurrent({ revoked: 0, expiration_date: "2099-01-01" })).toBe(true);
  });
});

describe("effectiveStatus", () => {
  it.each<[string, Pick<MemberRecord, "revoked" | "expiration_date">, string]>([
    ["current", { revoked: 0, expiration_date: "2026-09-16" }, "active"],
    // The case this exists for: a date passed, and no sync was there to notice.
    ["lapsed yesterday", { revoked: 0, expiration_date: "2026-09-15" }, "expired"],
    ["revoked, whatever the date says", { revoked: 1, expiration_date: "2099-01-01" }, "revoked"],
    ["no expiration on record", { revoked: 0, expiration_date: null }, "expired"],
  ])("%s -> %s", (_label, member, expected) => {
    expect(effectiveStatus(member, "2026-09-16")).toBe(expected);
  });

  it("defaults to today", () => {
    expect(effectiveStatus({ revoked: 0, expiration_date: "2099-01-01" })).toBe("active");
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

describe("a theme's artwork (#333)", () => {
  const BACKGROUND_KEY = "templates/themes/test/card-background.png";
  const THUMBNAIL_PREFIX = "templates/themes/test/apple/";
  const THUMBNAILS = ["thumbnail.png", "thumbnail@2x.png", "thumbnail@3x.png"];
  const APPLE_FILES = ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"];
  const THEME: CardTheme = {
    ...CLASSIC_THEME,
    id: "test",
    artwork: { cardBackground: BACKGROUND_KEY, appleThumbnailPrefix: THUMBNAIL_PREFIX },
  };

  beforeEach(() => {
    const chain = getTestCertChain();
    env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card.test";
    env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
    env.PASSKIT_ORGANIZATION_NAME = "Los Verdes";
    env.PASSKIT_WEB_SERVICE_URL = "https://card.losverd.es/passkit";
    env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
    env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
    env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
  });

  afterEach(async () => {
    const keys = [
      BACKGROUND_KEY,
      ...THUMBNAILS.map((name) => `${THUMBNAIL_PREFIX}${name}`),
      ...APPLE_FILES.map((name) => `templates/apple/${name}`),
      `cache/pkpass/pass.es.losverd.card.test/BC-1.pkpass`,
    ];
    await env.ASSETS.delete(keys);
  });

  it("draws the card image over the theme's background art", async () => {
    await insertMember();
    const member = (await getMemberById(env, "BC-1"))!;
    await env.ASSETS.put("templates/card/crest.png", new Uint8Array(LOGO));

    await expect(renderCardImage(env, member, THEME)).rejects.toThrow(/card-background\.png.*just r2-upload-templates/);

    await env.ASSETS.put(BACKGROUND_KEY, new Uint8Array(BACKGROUND));
    const themed = await renderCardImage(env, member, THEME);
    expect(themed).not.toEqual(await renderCardImage(env, member));
  });

  it("puts the theme's thumbnail in the Apple pass, at every scale", async () => {
    await insertMember();
    const member = (await getMemberById(env, "BC-1"))!;
    for (const name of APPLE_FILES) {
      await env.ASSETS.put(`templates/apple/${name}`, new Uint8Array([1, 2, 3]));
    }
    for (const name of THUMBNAILS) {
      await env.ASSETS.put(`${THUMBNAIL_PREFIX}${name}`, new TextEncoder().encode(name));
    }

    const files = unzipSync(await getApplePassBundle(env, member, THEME));

    for (const name of THUMBNAILS) {
      expect(new TextDecoder().decode(files[name])).toBe(name);
    }
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(Object.keys(manifest)).toEqual(expect.arrayContaining(THUMBNAILS));
  });

  it("leaves the thumbnail out of a classic pass", async () => {
    await insertMember();
    for (const name of APPLE_FILES) {
      await env.ASSETS.put(`templates/apple/${name}`, new Uint8Array([1, 2, 3]));
    }

    const files = unzipSync(await getApplePassBundle(env, (await getMemberById(env, "BC-1"))!));

    expect(Object.keys(files)).not.toContain("thumbnail.png");
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
    expect(await verifyPassSerialSignature({ current: PASS_KEY }, "BC-1", qr.searchParams.get("signature")!)).toBe("current");
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
