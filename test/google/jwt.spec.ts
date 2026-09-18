import { exportPKCS8, exportSPKI, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  buildGenericObject,
  googleWalletConfig,
  buildSaveToWalletPayload,
  buildSaveToWalletUrl,
  signSaveToWalletJwt,
  type GoogleWalletConfig,
  type GoogleWalletCredentials,
  type MemberWalletInput,
} from "../../src/google/jwt";

const CONFIG: GoogleWalletConfig = {
  issuerId: "3388000000022222222",
  classSuffix: "los_verdes_member_v1",
  origins: ["https://card.losverd.es"],
  cardTitle: "Los Verdes",
  hexBackgroundColor: "#00B140",
  logoUri: "https://card.losverd.es/assets/crest.png",
};

function makeMember(overrides: Partial<MemberWalletInput> = {}): MemberWalletInput {
  return {
    memberId: "LV-10023",
    firstName: "Jane",
    lastName: "Doe",
    membershipTier: "standard",
    status: "active",
    memberSince: "2021-07-15",
    expirationDate: "2024-02-17",
    verifyUrl: "https://card.losverd.es/verify-pass/LV-10023?signature=test-signature%3D",
    ...overrides,
  };
}

/**
 * Generates a throwaway RS256 key pair via Web Crypto, exported to the PEM
 * shapes `jose` expects -- the same "no real credentials available in this
 * environment yet, so test against a generated key pair" pattern
 * `test/passkit/signer.spec.ts` uses for PKCS#7 (see
 * `test/fixtures/certChain.ts`). A real Google Wallet service
 * account's PEM is PKCS#8, exactly what `exportPKCS8` produces here, so
 * `signSaveToWalletJwt` needs no change once real credentials land.
 */
async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const [privateKeyPem, publicKeyPem] = await Promise.all([
    exportPKCS8(privateKey),
    exportSPKI(publicKey),
  ]);
  return { privateKeyPem, publicKeyPem };
}

function testCredentials(privateKeyPem: string): GoogleWalletCredentials {
  return {
    serviceAccountEmail: "service-account@project.iam.gserviceaccount.com",
    privateKeyPem,
  };
}

describe("googleWalletConfig", () => {
  it("builds the whole config from the three things that differ per environment", () => {
    expect(
      googleWalletConfig({
        issuerId: "3388000000022222222",
        classSuffix: "los_verdes_member_staging_v1",
        baseUrl: "https://staging.example.test",
      }),
    ).toEqual({
      issuerId: "3388000000022222222",
      classSuffix: "los_verdes_member_staging_v1",
      origins: ["https://staging.example.test"],
      cardTitle: "Los Verdes",
      hexBackgroundColor: "#00B140",
      logoUri: "https://staging.example.test/assets/crest.png",
    });
  });

  it("gives the logo an absolute URL, since Google fetches it rather than being handed it", () => {
    // A relative or empty value is accepted by everything here and rejected by
    // Google with "URL cannot be empty", far from the cause.
    const { logoUri } = googleWalletConfig({
      issuerId: "1",
      classSuffix: "c",
      baseUrl: "https://card.losverd.es",
    });

    expect(() => new URL(logoUri)).not.toThrow();
    expect(logoUri).toBe("https://card.losverd.es/assets/crest.png");
  });
});

describe("buildGenericObject", () => {
  it("builds id/classId from the issuer id, and cardTitle/header from config and member name", () => {
    const object = buildGenericObject(makeMember({ firstName: "Pat", lastName: "Lee" }), CONFIG);

    expect(object.id).toBe("3388000000022222222.LV-10023");
    expect(object.classId).toBe("3388000000022222222.los_verdes_member_v1");
    expect(object.cardTitle).toEqual({ defaultValue: { language: "en-US", value: "Los Verdes" } });
    expect(object.header).toEqual({ defaultValue: { language: "en-US", value: "Pat Lee" } });
    expect(object.hexBackgroundColor).toBe("#00B140");
  });

  it("carries a logo Google can fetch, without which the save fails", () => {
    // Google will not take the image as bytes: it fetches this URL itself, so
    // it has to be absolute and served without a session (src/assets.ts).
    const object = buildGenericObject(makeMember(), CONFIG);

    expect(object.logo).toEqual({
      sourceUri: { uri: "https://card.losverd.es/assets/crest.png" },
      contentDescription: { defaultValue: { language: "en-US", value: "Los Verdes" } },
    });
  });

  it("always includes a membership tier text module", () => {
    const object = buildGenericObject(makeMember({ membershipTier: "los-pringles" }), CONFIG);
    expect(object.textModulesData).toContainEqual({
      id: "membership_tier",
      header: "Tier",
      body: "los-pringles",
    });
  });

  it("formats member_since as short-month + year when known", () => {
    const object = buildGenericObject(makeMember({ memberSince: "2021-07-15" }), CONFIG);
    expect(object.textModulesData).toContainEqual({
      id: "member_since",
      header: "Member Since",
      body: "Jul 2021",
    });
  });

  it("omits the member_since text module when not yet known", () => {
    const object = buildGenericObject(makeMember({ memberSince: null }), CONFIG);
    expect(object.textModulesData.some((m) => m.id === "member_since")).toBe(false);
  });

  it("formats the expiration date as short-month + day + year when known", () => {
    const object = buildGenericObject(makeMember({ expirationDate: "2024-02-17" }), CONFIG);
    expect(object.textModulesData).toContainEqual({
      id: "membership_expiry",
      header: "Good through",
      body: "Feb 17, 2024",
    });
  });

  it("omits the expiry text module when there's no expiration on record", () => {
    const object = buildGenericObject(makeMember({ expirationDate: null }), CONFIG);
    expect(object.textModulesData.some((m) => m.id === "membership_expiry")).toBe(false);
  });

  it("encodes the signed verify URL in the QR code, with the member id as alternate text", () => {
    const object = buildGenericObject(
      makeMember({ memberId: "LV-77777", verifyUrl: "https://card.losverd.es/verify-pass/LV-77777?signature=abc%3D" }),
      CONFIG,
    );
    expect(object.barcode).toEqual({
      type: "QR_CODE",
      value: "https://card.losverd.es/verify-pass/LV-77777?signature=abc%3D",
      alternateText: "LV-77777",
    });
  });

  it.each([
    ["active", "ACTIVE"],
    ["expired", "EXPIRED"],
    ["revoked", "INACTIVE"],
  ] as const)("maps member status %s to GenericObject state %s", (status, state) => {
    const object = buildGenericObject(makeMember({ status }), CONFIG);
    expect(object.state).toBe(state);
  });
});

describe("buildSaveToWalletPayload", () => {
  it("wraps a single genericObjects entry with the Phase 5.2 iss/aud/typ/origins envelope", () => {
    const payload = buildSaveToWalletPayload(
      makeMember(),
      CONFIG,
      "service-account@project.iam.gserviceaccount.com",
    );

    expect(payload.iss).toBe("service-account@project.iam.gserviceaccount.com");
    expect(payload.aud).toBe("google");
    expect(payload.typ).toBe("savetowallet");
    expect(payload.origins).toEqual(["https://card.losverd.es"]);
    expect(payload.payload.genericObjects).toEqual([buildGenericObject(makeMember(), CONFIG)]);
  });

  it("carries an issued-at claim in seconds, which Google requires", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = buildSaveToWalletPayload(makeMember(), CONFIG, "sa@project.iam.gserviceaccount.com");

    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(before + 5);
    expect(buildSaveToWalletPayload(makeMember(), CONFIG, "sa@project.iam.gserviceaccount.com", 1234567890).iat).toBe(1234567890);
  });
});

describe("signSaveToWalletJwt", () => {
  it("produces a compact JWT verifiable against the matching public key, with the expected payload", async () => {
    const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();

    const jwt = await signSaveToWalletJwt(makeMember(), CONFIG, testCredentials(privateKeyPem));

    expect(jwt.split(".")).toHaveLength(3);

    const publicKey = await importSPKI(publicKeyPem, "RS256");
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey);

    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.typ).toBe("JWT");
    expect(payload.iss).toBe("service-account@project.iam.gserviceaccount.com");
    expect(payload.aud).toBe("google");
    expect(payload.typ).toBe("savetowallet");
    expect(typeof payload.iat).toBe("number");
    expect(payload.origins).toEqual(["https://card.losverd.es"]);
    expect((payload.payload as { genericObjects: unknown[] }).genericObjects).toHaveLength(1);
  });

  it("fails verification against a non-matching public key", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const { publicKeyPem: wrongPublicKeyPem } = await generateTestKeyPair();

    const jwt = await signSaveToWalletJwt(makeMember(), CONFIG, testCredentials(privateKeyPem));

    const wrongPublicKey = await importSPKI(wrongPublicKeyPem, "RS256");
    await expect(jwtVerify(jwt, wrongPublicKey)).rejects.toThrow();
  });

  it("throws on a malformed private key PEM rather than signing silently", async () => {
    await expect(
      signSaveToWalletJwt(makeMember(), CONFIG, testCredentials("not a real PEM")),
    ).rejects.toThrow();
  });
});

describe("buildSaveToWalletUrl", () => {
  it("builds the Save to Google Wallet link from a signed JWT", () => {
    expect(buildSaveToWalletUrl("header.payload.signature")).toBe(
      "https://pay.google.com/gp/v/save/header.payload.signature",
    );
  });
});
