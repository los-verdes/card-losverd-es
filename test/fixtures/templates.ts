/**
 * The template images a test reads (src/templates.ts). By default the real
 * ones, bundled from assets/templates/ exactly as a deploy bundles them;
 * `useTemplates` swaps some for a test -- other bytes, or none at all -- and
 * records every key read. test/setup/templateCache.ts puts the real bundle
 * back before each test.
 */
import { env } from "cloudflare:test";

/** The bundle as the test pool provides it, before any test swaps it. */
export const bundledTemplates: Fetcher = env.STATIC;

export function useTemplates(files: Record<string, Uint8Array | null> = {}): { reads: string[] } {
  const reads: string[] = [];
  env.STATIC = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      const key = new URL(request.url).pathname.slice(1);
      reads.push(key);
      if (!(key in files)) return bundledTemplates.fetch(request);
      const bytes = files[key];
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers: { "Content-Type": "image/png", ETag: `"${key}"` } });
    },
  } as unknown as Fetcher;
  return { reads };
}
