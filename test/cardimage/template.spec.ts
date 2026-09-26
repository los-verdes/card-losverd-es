import { describe, expect, it } from "vitest";
import { buildCardTree, CREST_SIZE, type MembershipCardMember, type SatoriElement } from "../../src/cardimage/template";
import CREST_PNG from "../../assets/templates/card/crest.png";
import { CLASSIC_THEME } from "../../src/themes/cardTheme";

const IMAGES = {
  logoDataUrl: "data:image/png;base64,AAAA",
  qrDataUrl: "data:image/svg+xml;base64,AAAA",
  qrSize: 120,
};

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

function flattenText(el: SatoriElement | string): string[] {
  if (typeof el === "string") return [el];
  const children = el.props.children;
  if (children === undefined) return [];
  if (Array.isArray(children)) return children.flatMap(flattenText);
  return flattenText(children);
}

describe("buildCardTree", () => {
  it("includes the member's name and member id somewhere in the tree", () => {
    const tree = buildCardTree(
      makeMember({ firstName: "Pat", lastName: "Lee", memberId: "LV-99999" }),
      { memberSince: "Member since Jul 2021", expiration: "Good through Jan 15, 2027" },
      IMAGES,
    );
    const text = flattenText(tree);

    expect(text).toContain("Pat Lee");
    expect(text).toContain("LV-99999");
    expect(text).toContain("Good through Jan 15, 2027");
    expect(text).toContain("Member since Jul 2021");
  });

  it("omits a date line entirely rather than showing it blank", () => {
    const both = flattenText(
      buildCardTree(makeMember(), { memberSince: "Member since Jul 2021", expiration: "Good through Jan 15, 2027" }, IMAGES),
    );
    const neither = flattenText(buildCardTree(makeMember(), { memberSince: null, expiration: null }, IMAGES));
    const onlyExpiry = flattenText(
      buildCardTree(makeMember(), { memberSince: null, expiration: "Good through Jan 15, 2027" }, IMAGES),
    );

    expect(both).toContain("Member since Jul 2021");
    expect(both).toContain("Good through Jan 15, 2027");
    expect(neither).not.toContain("Good through Jan 15, 2027");
    expect(neither).not.toContain("Member since Jul 2021");
    expect(neither.length).toBe(both.length - 2);
    expect(onlyExpiry.length).toBe(both.length - 1);
  });

  it("puts member since above good through, as the Wallet passes do", () => {
    const text = flattenText(
      buildCardTree(makeMember(), { memberSince: "Member since Jul 2021", expiration: "Good through Jan 15, 2027" }, IMAGES),
    );

    expect(text.indexOf("Member since Jul 2021")).toBeLessThan(text.indexOf("Good through Jan 15, 2027"));
  });

  it("embeds the given logo and QR data URLs", () => {
    const tree = buildCardTree(makeMember(), { memberSince: null, expiration: null }, IMAGES);
    const json = JSON.stringify(tree);

    expect(json).toContain(IMAGES.logoDataUrl);
    expect(json).toContain(IMAGES.qrDataUrl);
  });
});

describe("the crest", () => {
  it("is drawn at CREST_SIZE", () => {
    const tree = buildCardTree(makeMember(), { memberSince: null, expiration: null }, IMAGES);
    const crest = (tree.props.children as SatoriElement[])[0].props.children as SatoriElement[];

    expect(crest[0].props).toMatchObject({ src: IMAGES.logoDataUrl, width: CREST_SIZE, height: CREST_SIZE });
  });

  it("is never drawn larger than the crest image itself, which would blur it", () => {
    // A PNG's width and height are the two big-endian words after the IHDR
    // tag, at bytes 16 and 20.
    const header = new DataView(CREST_PNG as ArrayBuffer);
    const width = header.getUint32(16);
    const height = header.getUint32(20);

    expect(CREST_SIZE).toBeLessThanOrEqual(Math.min(width, height));
  });
});

describe("buildCardTree with a theme", () => {
  const THEMED = {
    ...CLASSIC_THEME.colors,
    background: "#123456",
    border: "#654321",
    text: "#fedcba",
    secondaryText: "#abcdef",
    qrLabel: "#0f0f0f",
  };

  /** Every style value in the tree, flattened. */
  function styleValues(el: SatoriElement | string): unknown[] {
    if (typeof el === "string") return [];
    const own = Object.values(el.props.style ?? {});
    const children = el.props.children;
    const kids = children === undefined ? [] : Array.isArray(children) ? children : [children];
    return [...own, ...kids.flatMap(styleValues)];
  }

  it("draws in the theme's colours, and none of the classic ones", () => {
    const tree = buildCardTree(makeMember(), { memberSince: "Member since Jul 2021", expiration: "Good through Jan 15, 2027" }, IMAGES, THEMED);
    const values = styleValues(tree);

    expect(tree.props.style?.backgroundColor).toBe("#123456");
    expect(tree.props.style?.border).toBe("14px solid #654321");
    for (const colour of ["#fedcba", "#abcdef", "#0f0f0f"]) expect(values).toContain(colour);
    for (const classic of ["#00b140", "#046a29", "#d8f5e4"]) {
      expect(values.some((v) => typeof v === "string" && v.includes(classic))).toBe(false);
    }
  });

  it("keeps the QR code's box white whatever the theme, for the scanner's sake", () => {
    const tree = buildCardTree(makeMember(), { memberSince: null, expiration: null }, IMAGES, THEMED);

    expect(styleValues(tree)).toContain("#ffffff");
  });

  it("draws in classic when no theme is given", () => {
    const tree = buildCardTree(makeMember(), { memberSince: null, expiration: null }, IMAGES);

    expect(tree.props.style?.backgroundColor).toBe(CLASSIC_THEME.colors.background);
  });
});
