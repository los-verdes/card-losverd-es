import { describe, expect, it } from "vitest";
import { fitImageRequests, textColumnWidth, type DocsDocument } from "../../scripts/lib/fitDocImages";

/** A Doc whose body holds an image of each size, as `documents.get` returns it. */
function doc(sizes: [number, number][], style?: DocsDocument["documentStyle"]): DocsDocument {
  return {
    documentStyle: style,
    body: {
      content: [
        { paragraph: { elements: [{ startIndex: 1 }] } },
        ...sizes.map((_, i) => ({
          paragraph: { elements: [{ startIndex: 10 * (i + 1), inlineObjectElement: { inlineObjectId: `img${i}` } }] },
        })),
      ],
    },
    inlineObjects: Object.fromEntries(
      sizes.map(([width, height], i) => [
        `img${i}`,
        { inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: width }, height: { magnitude: height } } } } },
      ]),
    ),
  };
}

describe("textColumnWidth", () => {
  it("is the page less its margins", () => {
    expect(textColumnWidth(doc([], { pageSize: { width: { magnitude: 612 } }, marginLeft: { magnitude: 54 }, marginRight: { magnitude: 54 } }))).toBe(504);
  });

  it("assumes US Letter with one-inch margins when the Doc does not say", () => {
    expect(textColumnWidth(doc([]))).toBe(468);
  });
});

describe("fitImageRequests", () => {
  it("re-inserts only the images wider than the column, at its width, keeping proportions, last first", () => {
    const result = fitImageRequests(doc([[936, 300], [400, 200], [702, 702]]), ["u0", "u1", "u2"]);

    expect(result).toEqual({
      resized: 2,
      requests: [
        { deleteContentRange: { range: { startIndex: 30, endIndex: 31 } } },
        { insertInlineImage: { location: { index: 30 }, uri: "u2", objectSize: { width: { magnitude: 468, unit: "PT" }, height: { magnitude: 468, unit: "PT" } } } },
        { deleteContentRange: { range: { startIndex: 10, endIndex: 11 } } },
        { insertInlineImage: { location: { index: 10 }, uri: "u0", objectSize: { width: { magnitude: 468, unit: "PT" }, height: { magnitude: 150, unit: "PT" } } } },
      ],
    });
  });

  it("asks for nothing when every image fits", () => {
    expect(fitImageRequests(doc([[468, 100], [200, 50]]), ["u0", "u1"])).toEqual({ requests: [], resized: 0 });
  });

  it("declines to guess when the Doc's images are not the ones expected", () => {
    expect(fitImageRequests(doc([[900, 300]]), ["u0", "u1"])).toEqual({
      mismatch: "the Doc has 1 image(s) where 2 were expected",
    });
  });

  it("leaves alone an image whose size the Doc does not report", () => {
    const unsized: DocsDocument = { ...doc([[900, 300]]), inlineObjects: { img0: {} } };

    expect(fitImageRequests(unsized, ["u0"])).toEqual({ requests: [], resized: 0 });
  });
});
