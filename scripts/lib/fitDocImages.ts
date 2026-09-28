/**
 * Shrinks a Google Doc's images to fit its text column
 * (scripts/provenance-gdoc-push.mjs).
 *
 * Markdown cannot say how wide an image should be, so Drive's import gives
 * each one its natural size, and a diagram wider than the page runs off its
 * right-hand side. The Docs API cannot resize an image in place either; the
 * way to do it is to delete it and insert it again at the size wanted, from
 * the same URL. That is what these requests do, for every image wider than
 * the space between the margins, keeping its proportions. Images that
 * already fit are left alone.
 */

/** The parts of a Docs API `documents.get` response this reads. Sizes are in points. */
export interface DocsDocument {
  documentStyle?: {
    pageSize?: { width?: { magnitude?: number } };
    marginLeft?: { magnitude?: number };
    marginRight?: { magnitude?: number };
  };
  body?: {
    content?: {
      paragraph?: { elements?: { startIndex?: number; inlineObjectElement?: { inlineObjectId?: string } }[] };
    }[];
  };
  inlineObjects?: Record<
    string,
    {
      inlineObjectProperties?: {
        embeddedObject?: { size?: { width?: { magnitude?: number }; height?: { magnitude?: number } } };
      };
    }
  >;
}

/** US Letter with one-inch margins: what a new Doc has, and what an absent style means. */
const DEFAULT_PAGE_WIDTH = 612;
const DEFAULT_MARGIN = 72;

/** The width available to an image, in points. */
export function textColumnWidth(doc: DocsDocument): number {
  const style = doc.documentStyle ?? {};
  return (
    (style.pageSize?.width?.magnitude ?? DEFAULT_PAGE_WIDTH) -
    (style.marginLeft?.magnitude ?? DEFAULT_MARGIN) -
    (style.marginRight?.magnitude ?? DEFAULT_MARGIN)
  );
}

interface PlacedImage {
  index: number;
  width: number;
  height: number;
}

/** Every inline image in the body, in document order. */
function images(doc: DocsDocument): PlacedImage[] {
  const found: PlacedImage[] = [];
  for (const block of doc.body?.content ?? []) {
    for (const element of block.paragraph?.elements ?? []) {
      const id = element.inlineObjectElement?.inlineObjectId;
      if (!id || element.startIndex === undefined) continue;
      const size = doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject?.size;
      found.push({
        index: element.startIndex,
        width: size?.width?.magnitude ?? 0,
        height: size?.height?.magnitude ?? 0,
      });
    }
  }
  return found;
}

/**
 * `documents.batchUpdate` requests that re-insert each too-wide image at the
 * column's width, or an empty list when every image fits. `urls` are where
 * the images came from, in document order; the document's images must be
 * exactly those, or this declines to guess which is which.
 */
export function fitImageRequests(doc: DocsDocument, urls: string[]): { requests: object[]; resized: number } | { mismatch: string } {
  const placed = images(doc);
  if (placed.length !== urls.length) {
    return { mismatch: `the Doc has ${placed.length} image(s) where ${urls.length} were expected` };
  }
  const column = textColumnWidth(doc);
  const requests: object[] = [];
  let resized = 0;
  // Last first, so each change leaves the positions of those before it alone.
  for (let i = placed.length - 1; i >= 0; i--) {
    const image = placed[i];
    if (image.width <= column || image.height <= 0) continue;
    resized++;
    requests.push(
      { deleteContentRange: { range: { startIndex: image.index, endIndex: image.index + 1 } } },
      {
        insertInlineImage: {
          location: { index: image.index },
          uri: urls[i],
          objectSize: {
            width: { magnitude: column, unit: "PT" },
            height: { magnitude: (image.height * column) / image.width, unit: "PT" },
          },
        },
      },
    );
  }
  return { requests, resized };
}
