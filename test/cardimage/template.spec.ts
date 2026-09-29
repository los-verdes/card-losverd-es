import { describe, expect, it } from "vitest";
import { buildCardTree, cardNumberLines, CREST_SIZE, nameFontSize, type MembershipCardMember, type SatoriElement } from "../../src/cardimage/template";
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

describe("buildCardTree with background art", () => {
  const LABELS = { memberSince: null, expiration: null };

  it("draws the art across the whole card, under everything else", () => {
    const tree = buildCardTree(makeMember(), LABELS, { ...IMAGES, backgroundDataUrl: "data:image/png;base64,BBBB" });

    expect(tree.props.style).toMatchObject({
      backgroundImage: "url(data:image/png;base64,BBBB)",
      backgroundSize: "1050px 660px",
      backgroundRepeat: "no-repeat",
      // The theme's colour stays, for any part the art leaves transparent.
      backgroundColor: CLASSIC_THEME.colors.background,
    });
  });

  it("leaves the background plain without art", () => {
    const tree = buildCardTree(makeMember(), LABELS, IMAGES);

    expect(tree.props.style).not.toHaveProperty("backgroundImage");
  });
});

/** Every element in the tree, depth first. */
function elements(el: SatoriElement | string): SatoriElement[] {
  if (typeof el === "string") return [];
  const children = el.props.children;
  const list = children === undefined ? [] : Array.isArray(children) ? children : [children];
  return [el, ...list.flatMap(elements)];
}

describe("a long name", () => {
  const LONGEST = "Maximiliano Alejandro Fernández de la Torre y Villanueva Ruiz Paz"; // 64, the most a card allows

  it("is drawn smaller the longer it is, so the longest stays within three lines", () => {
    expect(nameFontSize("Ana Ruiz")).toBe(46);
    expect(nameFontSize("x".repeat(40))).toBe(46);
    expect(nameFontSize("x".repeat(41))).toBe(38);
    expect(nameFontSize("x".repeat(52))).toBe(38);
    expect(nameFontSize(LONGEST)).toBe(32);
    // Counted in characters, not UTF-16 units.
    expect(nameFontSize("é".repeat(40))).toBe(46);
  });

  it("wraps in whatever space the QR code's box leaves, breaking a word only when it must", () => {
    const tree = buildCardTree(makeMember({ firstName: LONGEST, lastName: "" }), { memberSince: null, expiration: null }, IMAGES);
    const all = elements(tree);
    const name = all.find((el) => el.props.children === LONGEST)!;
    const column = all.find((el) => Array.isArray(el.props.children) && el.props.children.includes(name))!;
    const qrBox = all.find((el) => el.props.style?.backgroundColor === "#ffffff")!;

    expect(name.props.style).toMatchObject({ fontSize: 32, wordBreak: "break-word" });
    // The column takes the rest of the row and may shrink below its text's
    // width, so the text wraps rather than pushing the box off the card.
    expect(column.props.style).toMatchObject({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
    expect(column.props.style).not.toHaveProperty("maxWidth");
    expect(qrBox.props.style).toMatchObject({ flexShrink: 0 });
  });
});

describe("the card number under the QR code", () => {
  it("splits a full-length number at the hyphen nearest its middle, so the box is no wider than the code", () => {
    expect(cardNumberLines("LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6")).toEqual(["LV-6f1c8e40-0000-4000-", "8000-a1b2c3d4e5f6"]);
  });

  it("keeps a short number, or one with nowhere to split, on one line", () => {
    expect(cardNumberLines("LV-10023")).toEqual(["LV-10023"]);
    expect(cardNumberLines("x".repeat(30))).toEqual(["x".repeat(30)]);
  });

  it("prints every line of it in the QR code's box", () => {
    const tree = buildCardTree(makeMember({ memberId: "LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6" }), { memberSince: null, expiration: null }, IMAGES);
    const text = flattenText(tree);

    expect(text).toContain("LV-6f1c8e40-0000-4000-");
    expect(text).toContain("8000-a1b2c3d4e5f6");
  });
});
