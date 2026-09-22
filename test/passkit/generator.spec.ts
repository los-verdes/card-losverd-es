import { env } from "cloudflare:test";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { getTestCertChain } from "../fixtures/certChain";
import type { PassSigningCredentials } from "../../src/passkit/signer";
import {
  assemblePassBundle,
  buildManifest,
  buildPassJson,
  getCachedPass,
  invalidateCachedPass,
  PASS_CONTENT_VERSION,
  putCachedPass,
  type MemberPassInput,
  type PassKitConfig,
} from "../../src/passkit/generator";

// Matches a real pass issued by the legacy production app, used to validate
// this generator's output shape - but with fabricated values throughout, not
// any real member's actual name/email/tokens/signature.
const CONFIG: PassKitConfig = {
  passTypeIdentifier: "pass.es.losverd.card",
  teamIdentifier: "TEAMID1234",
  organizationName: "Los Verdes",
  webServiceURL: "https://card.losverd.es/passkit",
};

function makeMember(overrides: Partial<MemberPassInput> = {}): MemberPassInput {
  return {
    memberId: "LV-10023",
    firstName: "Jane",
    lastName: "Doe",
    status: "active",
    memberSince: "2021-07-15",
    expirationDate: "2024-02-17",
    authToken: "test-auth-token",
    verifyUrl: "https://card.losverd.es/verify-pass/LV-10023?signature=test-signature%3D",
    ...overrides,
  };
}

function testSigningCredentials(): PassSigningCredentials {
  const chain = getTestCertChain();
  return {
    signingCertPem: chain.leafCertPem,
    signingKeyPem: chain.leafPrivateKeyPem,
    wwdrCertPem: chain.rootCertPem,
  };
}

describe("buildPassJson", () => {
  const BUILT_AT = new Date("2026-09-19T11:22:33Z");

  function parse(member: MemberPassInput, config: PassKitConfig = CONFIG) {
    return JSON.parse(new TextDecoder().decode(buildPassJson(member, config, BUILT_AT)));
  }

  it("builds top-level identifiers from config and the member", () => {
    const pass = parse(makeMember());

    expect(pass.formatVersion).toBe(1);
    expect(pass.passTypeIdentifier).toBe("pass.es.losverd.card");
    expect(pass.teamIdentifier).toBe("TEAMID1234");
    expect(pass.organizationName).toBe("Los Verdes");
    expect(pass.webServiceURL).toBe("https://card.losverd.es/passkit");
    expect(pass.serialNumber).toBe("LV-10023");
    expect(pass.authenticationToken).toBe("test-auth-token");
    expect(pass.description).toBeTruthy();
    expect(pass.suppressStripShine).toBe(false);
  });

  it("uses well-formed rgb() color strings (not the legacy app's malformed one)", () => {
    const pass = parse(makeMember());
    expect(pass.backgroundColor).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(pass.foregroundColor).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it("keeps organizationName distinct from teamIdentifier (not the legacy app's mixed-up values)", () => {
    const pass = parse(makeMember());
    expect(pass.organizationName).not.toBe(pass.teamIdentifier);
  });

  it("renders the primary name field from first + last name", () => {
    const pass = parse(makeMember({ firstName: "Pat", lastName: "Lee" }));
    expect(pass.generic.primaryFields).toEqual([
      {
        key: "name",
        label: "Member Name",
        value: "Pat Lee",
        textAlignment: "PKTextAlignmentLeft",
      },
    ]);
  });

  it("has no auxiliary fields, the tier having been the only one", () => {
    // Omitted rather than empty, the tier having been dropped. Wallet lays the front of
    // the card out from the keys present, and an installed pass picks this up
    // the next time it is rebuilt.
    const pass = parse(makeMember({}));
    expect(pass.generic.auxiliaryFields).toBeUndefined();
  });

  it("formats member_since as short-month + year", () => {
    const pass = parse(makeMember({ memberSince: "2021-07-15" }));
    const field = pass.generic.secondaryFields.find(
      (f: { key: string }) => f.key === "member_since",
    );
    expect(field).toEqual({
      key: "member_since",
      label: "Member Since",
      value: "Jul 2021",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("formats the expiration date as short-month + day + year", () => {
    const pass = parse(makeMember({ expirationDate: "2024-02-17" }));
    const field = pass.generic.secondaryFields.find(
      (f: { key: string }) => f.key === "membership_expiry",
    );
    expect(field).toEqual({
      key: "membership_expiry",
      label: "Good through",
      value: "Feb 17, 2024",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("omits member_since from secondaryFields when not yet known", () => {
    const pass = parse(makeMember({ memberSince: null }));
    expect(
      pass.generic.secondaryFields.some(
        (f: { key: string }) => f.key === "member_since",
      ),
    ).toBe(false);
  });

  it("tells Wallet when the pass expires: the end of the expiry day, UTC (#295)", () => {
    // UTC because the site's own check compares UTC dates; the phone must
    // not disagree with it about whether the membership is current.
    expect(parse(makeMember({ expirationDate: "2024-02-17" })).expirationDate).toBe("2024-02-17T23:59:59+00:00");
  });

  it("states no expiry to Wallet without one on record, as for a revoked membership", () => {
    expect("expirationDate" in parse(makeMember({ expirationDate: null }))).toBe(false);
  });

  it("omits the expiry field when there's no expiration on record", () => {
    const pass = parse(makeMember({ expirationDate: null }));
    expect(
      pass.generic.secondaryFields.some(
        (f: { key: string }) => f.key === "membership_expiry",
      ),
    ).toBe(false);
  });

  it("shows the member id as the Card # back field, with no status note for an active member", () => {
    const pass = parse(makeMember({ memberId: "LV-10023", status: "active" }));
    expect(pass.generic.backFields.filter((f: { key: string }) => f.key === "status")).toEqual([]);
    expect(pass.generic.backFields[0]).toEqual({
      key: "member_id",
      label: "Card #",
      value: "LV-10023",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("ends the back with what to ask a member for when their pass looks stale", () => {
    // Deliberately last, under everything anyone reads on purpose. A member
    // can read these off their phone, and between them they answer whether
    // the pass was built by the code we think it was, and when.
    const back = parse(makeMember()).generic.backFields;

    expect(back.slice(-2)).toEqual([
      {
        key: "card_version",
        label: "Card version",
        value: PASS_CONTENT_VERSION,
        textAlignment: "PKTextAlignmentLeft",
      },
      {
        key: "built_at",
        label: "Built",
        value: "2026-09-19",
        textAlignment: "PKTextAlignmentLeft",
      },
    ]);
  });

  it("marks a pass as staging's, and says nothing on a production one", () => {
    // A pass installed from staging by accident points at staging's web
    // service and will never be updated by production. Better that it says so
    // than that someone works it out from a pass that simply stops changing.
    const staging = parse(makeMember(), { ...CONFIG, environment: "staging" });
    expect(staging.generic.backFields).toContainEqual({
      key: "environment",
      label: "Environment",
      value: "staging",
      textAlignment: "PKTextAlignmentLeft",
    });

    const production = parse(makeMember(), { ...CONFIG, environment: "production" });
    expect(
      production.generic.backFields.some((f: { key: string }) => f.key === "environment"),
    ).toBe(false);
  });

  it("adds a Status back field for an expired or revoked member", () => {
    const expired = parse(makeMember({ status: "expired" }));
    expect(expired.generic.backFields).toContainEqual({
      key: "status",
      label: "Status",
      value: "Expired",
      textAlignment: "PKTextAlignmentLeft",
    });

    const revoked = parse(makeMember({ status: "revoked" }));
    expect(revoked.generic.backFields).toContainEqual({
      key: "status",
      label: "Status",
      value: "Revoked",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("encodes the signed verify URL in the QR barcode, iso-8859-1 encoded", () => {
    const pass = parse(
      makeMember({ memberId: "LV-77777", verifyUrl: "https://card.losverd.es/verify-pass/LV-77777?signature=abc%3D" }),
    );
    expect(pass.barcode).toEqual({
      format: "PKBarcodeFormatQR",
      message: "https://card.losverd.es/verify-pass/LV-77777?signature=abc%3D",
      messageEncoding: "iso-8859-1",
      altText: "",
    });
  });
});

describe("assemblePassBundle", () => {
  it("produces a zip containing a signed pass.json + manifest + assets", async () => {
    const assets = { "icon.png": new Uint8Array([1, 2, 3]) };

    const bundle = await assemblePassBundle(
      makeMember(),
      CONFIG,
      assets,
      testSigningCredentials(),
    );

    const files = unzipSync(bundle);
    expect(Object.keys(files).sort()).toEqual([
      "icon.png",
      "manifest.json",
      "pass.json",
      "signature",
    ]);

    const passJson = JSON.parse(new TextDecoder().decode(files["pass.json"]));
    expect(passJson.serialNumber).toBe("LV-10023");

    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(Object.keys(manifest).sort()).toEqual(["icon.png", "pass.json"]);

    expect(files["signature"][0]).toBe(0x30); // DER SEQUENCE tag
  });
});

describe("buildManifest", () => {
  it("hashes every file with SHA-1, hex-encoded", async () => {
    const files = {
      "pass.json": new TextEncoder().encode('{"hello":"world"}'),
      "icon.png": new Uint8Array([1, 2, 3, 4]),
    };

    const manifestBytes = await buildManifest(files);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

    expect(Object.keys(manifest).sort()).toEqual(["icon.png", "pass.json"]);
    for (const hash of Object.values(manifest)) {
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("produces a different hash when file content changes", async () => {
    const a = await buildManifest({ "pass.json": new TextEncoder().encode("a") });
    const b = await buildManifest({ "pass.json": new TextEncoder().encode("b") });
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });
});

describe("pass cache (R2)", () => {
  afterEach(async () => {
    await invalidateCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023");
  });

  it("returns null on a cache miss", async () => {
    const cached = await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-NOPE", 1);
    expect(cached).toBeNull();
  });

  it("round-trips bytes written via putCachedPass", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]); // PK.. zip magic, arbitrary test payload
    await putCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000, bytes);

    const cached = await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000);

    expect(cached).not.toBeNull();
    expect(Array.from(cached!)).toEqual(Array.from(bytes));
  });

  it("treats a pass cached from an older member version as a miss", async () => {
    await putCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000, new Uint8Array([1]));

    expect(await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 2000)).toBeNull();
  });

  it("misses when the pass content version has moved on, even for an unchanged member", async () => {
    // The case the member version cannot cover. A member whose details are
    // stable never bumps `last_updated_at`, so without this a change to what
    // a pass contains would never reach them -- they would keep being handed
    // the pass the old code built, indefinitely.
    await putCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000, new Uint8Array([1]));
    const key = "cache/pkpass/pass.es.losverd.membership/LV-10023.pkpass";
    const stored = await env.ASSETS.get(key);
    await env.ASSETS.put(key, await stored!.arrayBuffer(), {
      customMetadata: { lastUpdatedAt: "1000", passContentVersion: "an-older-version" },
    });

    expect(
      await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000),
    ).toBeNull();
  });

  it("misses a pass cached before content versions existed at all", async () => {
    // Objects already in R2 carry no version metadata, so the first deploy
    // after this regenerates them rather than serving them forever.
    await env.ASSETS.put(
      "cache/pkpass/pass.es.losverd.membership/LV-10023.pkpass",
      new Uint8Array([1]),
      { customMetadata: { lastUpdatedAt: "1000" } },
    );

    expect(
      await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000),
    ).toBeNull();
  });

  it("treats a cached object without version metadata as a miss", async () => {
    await env.ASSETS.put("cache/pkpass/pass.es.losverd.membership/LV-10023.pkpass", new Uint8Array([1]));

    expect(await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000)).toBeNull();
  });

  it("invalidateCachedPass removes a cached entry", async () => {
    await putCachedPass(
      env.ASSETS,
      "pass.es.losverd.membership",
      "LV-10023",
      1000,
      new Uint8Array([1]),
    );

    await invalidateCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023");

    expect(
      await getCachedPass(env.ASSETS, "pass.es.losverd.membership", "LV-10023", 1000),
    ).toBeNull();
  });
});
