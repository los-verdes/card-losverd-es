import { describe, expect, it } from "vitest";
import { buildCardTree, type MembershipCardMember, type SatoriElement } from "../../src/cardimage/template";

const IMAGES = {
  logoDataUrl: "data:image/png;base64,AAAA",
  qrDataUrl: "data:image/svg+xml;base64,AAAA",
  qrSize: 120,
};

function makeMember(overrides: Partial<MembershipCardMember> = {}): MembershipCardMember {
  return {
    firstName: "Jane",
    lastName: "Doe",
    membershipTier: "standard",
    memberId: "LV-10023",
    expirationDate: "2027-01-15",
    ...overrides,
  };
}

function flattenText(el: SatoriElement | string): string[] {
  if (typeof el === "string") return [el];
  const children = el.props.children;
  if (children === undefined) return [];
  if (Array.isArray(children)) return children.flatMap(flattenText);
  return flattenText(children);
}

describe("buildCardTree", () => {
  it("includes the member's name, tier, and member id somewhere in the tree", () => {
    const tree = buildCardTree(
      makeMember({ firstName: "Pat", lastName: "Lee", membershipTier: "los-pringles", memberId: "LV-99999" }),
      "Good through Jan 15, 2027",
      IMAGES,
    );
    const text = flattenText(tree);

    expect(text).toContain("Pat Lee");
    expect(text).toContain("los-pringles");
    expect(text).toContain("LV-99999");
    expect(text).toContain("Good through Jan 15, 2027");
  });

  it("omits the expiration line entirely when no label is given", () => {
    const withLabel = flattenText(buildCardTree(makeMember(), "Good through Jan 15, 2027", IMAGES));
    const withoutLabel = flattenText(buildCardTree(makeMember(), null, IMAGES));

    expect(withLabel).toContain("Good through Jan 15, 2027");
    expect(withoutLabel).not.toContain("Good through Jan 15, 2027");
    expect(withoutLabel.length).toBe(withLabel.length - 1);
  });

  it("embeds the given logo and QR data URLs", () => {
    const tree = buildCardTree(makeMember(), null, IMAGES);
    const json = JSON.stringify(tree);

    expect(json).toContain(IMAGES.logoDataUrl);
    expect(json).toContain(IMAGES.qrDataUrl);
  });
});
