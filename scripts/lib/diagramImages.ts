/**
 * The provenance document's Mermaid diagrams as images, for its Google Doc
 * copy (scripts/provenance-gdoc.mjs). Google Docs cannot render Mermaid, and
 * its source pasted into a document for volunteers looks like something went
 * wrong.
 *
 * Each diagram becomes a Kroki (https://kroki.io) image URL with the diagram
 * itself encoded in it, so the picture always matches the commit it was taken
 * from, and there is nothing to build, store or keep in step. The diagrams
 * describe how the software works and carry nothing about anybody, so handing
 * their text to a public renderer costs nothing. Kroki is open source and can
 * be run privately if that ever changes; only the root below would move.
 */

import { deflateSync } from "node:zlib";

export const KROKI_ROOT = "https://kroki.io";

/** Kroki's encoding: zlib-deflated, then URL-safe base64. */
export function mermaidPngUrl(source: string, root: string = KROKI_ROOT): string {
  const encoded = Buffer.from(deflateSync(Buffer.from(source, "utf8"), { level: 9 })).toString("base64url");
  return `${root}/mermaid/png/${encoded}`;
}

export interface Diagram {
  /** 1-based, in document order, as the Doc numbers them. */
  number: number;
  source: string;
}

/** Every ```mermaid block in `markdown`, replaced by whatever `replace` returns for it. */
export function replaceDiagrams(
  markdown: string,
  replace: (diagram: Diagram) => string,
): { markdown: string; diagrams: Diagram[] } {
  const diagrams: Diagram[] = [];
  const replaced = markdown.replace(/```mermaid\n([\s\S]*?)\n```/g, (_, source: string) => {
    const diagram = { number: diagrams.length + 1, source };
    diagrams.push(diagram);
    return replace(diagram);
  });
  return { markdown: replaced, diagrams };
}

/** The image URLs a prepared copy points at, so the push can check each one renders. */
export function diagramImageUrls(markdown: string): string[] {
  return [...markdown.matchAll(/!\[Diagram \d+\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}
