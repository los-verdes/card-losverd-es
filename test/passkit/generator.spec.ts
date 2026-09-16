import { describe, expect, it } from "vitest";
import { buildPassJson, type PassContentMember, type PassKitConfig } from "../../src/passkit/generator";

// Matches the real example pass (`lv_apple_pass-hogan.pkpass`) pulled from
// the legacy production app, used to validate this generator's output shape
// - but with fabricated values throughout, not the real member's actual
// name/email/tokens/signature.
const CONFIG: PassKitConfig = {
  passTypeIdentifier: "pass.es.losverd.card",
  teamIdentifier: "TEAMID1234",
  organizationName: "Los Verdes",
  description: "Los Verdes Membership Card",
  webServiceURL: "https://card.losverd.es/passkit",
  backgroundColor: "rgb(0, 177, 64)",
  foregroundColor: "rgb(0, 0, 0)",
  logoText: "Los Verdes",
};

function makeMember(
  overrides: Partial<PassContentMember> = {},
): PassContentMember {
  return {
    memberId: "LV-10023",
    firstName: "Jane",
    lastName: "Doe",
    memberSince: "2021-07-15",
    expirationDate: "2024-02-17",
    authToken: "test-auth-token",
    verifyUrl:
      "https://card.losverd.es/verify-pass/LV-10023?signature=test-signature",
    ...overrides,
  };
}

describe("buildPassJson", () => {
  it("builds top-level identifiers and branding from config, not the member", () => {
    const pass = buildPassJson(makeMember(), CONFIG);

    expect(pass.formatVersion).toBe(1);
    expect(pass.passTypeIdentifier).toBe("pass.es.losverd.card");
    expect(pass.teamIdentifier).toBe("TEAMID1234");
    expect(pass.organizationName).toBe("Los Verdes");
    expect(pass.description).toBe("Los Verdes Membership Card");
    expect(pass.webServiceURL).toBe("https://card.losverd.es/passkit");
    expect(pass.logoText).toBe("Los Verdes");
    expect(pass.suppressStripShine).toBe(false);
  });

  it("uses well-formed rgb() color strings (not the legacy app's malformed one)", () => {
    const pass = buildPassJson(makeMember(), CONFIG);
    expect(pass.backgroundColor).toBe("rgb(0, 177, 64)");
    expect(pass.foregroundColor).toBe("rgb(0, 0, 0)");
  });

  it("keeps organizationName distinct from teamIdentifier (not the legacy app's mixed-up values)", () => {
    const pass = buildPassJson(makeMember(), CONFIG);
    expect(pass.organizationName).not.toBe(pass.teamIdentifier);
  });

  it("uses the member's id as both serialNumber and the barcode-adjacent identity", () => {
    const pass = buildPassJson(makeMember({ memberId: "LV-99999" }), CONFIG);
    expect(pass.serialNumber).toBe("LV-99999");
  });

  it("renders the primary name field from first + last name", () => {
    const pass = buildPassJson(
      makeMember({ firstName: "Pat", lastName: "Lee" }),
      CONFIG,
    );
    expect(pass.generic.primaryFields).toEqual([
      {
        key: "name",
        label: "Member Name",
        value: "Pat Lee",
        textAlignment: "PKTextAlignmentLeft",
      },
    ]);
  });

  it("formats member_since as short-month + year", () => {
    const pass = buildPassJson(
      makeMember({ memberSince: "2021-07-15" }),
      CONFIG,
    );
    const field = pass.generic.secondaryFields.find(
      (f) => f.key === "member_since",
    );
    expect(field).toEqual({
      key: "member_since",
      label: "Member Since",
      value: "Jul 2021",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("formats the expiration date as short-month + day + year", () => {
    const pass = buildPassJson(
      makeMember({ expirationDate: "2024-02-17" }),
      CONFIG,
    );
    const field = pass.generic.secondaryFields.find(
      (f) => f.key === "membership_expiry",
    );
    expect(field).toEqual({
      key: "membership_expiry",
      label: "Good through",
      value: "Feb 17, 2024",
      textAlignment: "PKTextAlignmentLeft",
    });
  });

  it("omits member_since from secondaryFields when not yet known", () => {
    const pass = buildPassJson(makeMember({ memberSince: null }), CONFIG);
    expect(
      pass.generic.secondaryFields.some((f) => f.key === "member_since"),
    ).toBe(false);
  });

  it("omits the expiry field from secondaryFields when there's no expiration on record", () => {
    const pass = buildPassJson(makeMember({ expirationDate: null }), CONFIG);
    expect(
      pass.generic.secondaryFields.some((f) => f.key === "membership_expiry"),
    ).toBe(false);
  });

  it("renders no secondaryFields at all when neither date is known", () => {
    const pass = buildPassJson(
      makeMember({ memberSince: null, expirationDate: null }),
      CONFIG,
    );
    expect(pass.generic.secondaryFields).toEqual([]);
  });

  it("shows the member id as the Card # back field", () => {
    const pass = buildPassJson(makeMember({ memberId: "LV-10023" }), CONFIG);
    expect(pass.generic.backFields).toEqual([
      {
        key: "member_id",
        label: "Card #",
        value: "LV-10023",
        textAlignment: "PKTextAlignmentLeft",
      },
    ]);
  });

  it("builds a QR barcode from the pre-signed verify URL, iso-8859-1 encoded", () => {
    const pass = buildPassJson(
      makeMember({
        verifyUrl: "https://card.losverd.es/verify-pass/LV-10023?signature=abc",
      }),
      CONFIG,
    );
    expect(pass.barcode).toEqual({
      format: "PKBarcodeFormatQR",
      message: "https://card.losverd.es/verify-pass/LV-10023?signature=abc",
      messageEncoding: "iso-8859-1",
      altText: "",
    });
  });

  it("passes the member's auth token through as authenticationToken", () => {
    const pass = buildPassJson(
      makeMember({ authToken: "some-secret-token" }),
      CONFIG,
    );
    expect(pass.authenticationToken).toBe("some-secret-token");
  });
});
