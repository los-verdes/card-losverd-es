import { describe, expect, it } from "vitest";
import sampleLogoPng from "../fixtures/sample-logo.png";
import { renderMembershipCardPng } from "../../src/cardimage/render";
import type { MembershipCardMember } from "../../src/cardimage/template";

// PNG file signature: 0x89 'P' 'N' 'G' \r \n 0x1A \n
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const LOGO_BYTES = new Uint8Array(sampleLogoPng);

function makeMember(overrides: Partial<MembershipCardMember> = {}): MembershipCardMember {
  return {
    firstName: "Jane",
    lastName: "Doe",
    memberId: "LV-10023",
    verifyUrl: "https://card.losverd.es/verify-pass/LV-10023?signature=test-signature%3D",
    expirationDate: "2027-01-15",
    memberSince: "2021-07-04",
    ...overrides,
  };
}

describe("renderMembershipCardPng", () => {
  it("renders a non-trivial PNG for a member with an expiration date", async () => {
    const png = await renderMembershipCardPng(makeMember(), LOGO_BYTES);

    expect(Array.from(png.slice(0, 8))).toEqual(PNG_MAGIC);
    // A ~1050x660 rendered card should be comfortably more than a few KB;
    // this guards against a "successful" render that's actually a blank or
    // near-blank image (e.g. Satori's remote-image-fetch-fails-silently
    // failure mode the migration plan warns about).
    expect(png.byteLength).toBeGreaterThan(5_000);
  });

  it("renders successfully for a member with no expiration date on record", async () => {
    const png = await renderMembershipCardPng(
      makeMember({ expirationDate: null }),
      LOGO_BYTES,
    );

    expect(Array.from(png.slice(0, 8))).toEqual(PNG_MAGIC);
    expect(png.byteLength).toBeGreaterThan(5_000);
  });

  it("renders successfully for a member with no member-since date on record", async () => {
    // Neither a counted order nor an override supplied one -- the line is
    // dropped rather than rendered blank.
    const png = await renderMembershipCardPng(
      makeMember({ memberSince: null }),
      LOGO_BYTES,
    );

    expect(Array.from(png.slice(0, 8))).toEqual(PNG_MAGIC);
    expect(png.byteLength).toBeGreaterThan(5_000);
  });
});
