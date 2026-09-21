/**
 * An in-memory stand-in for Cloudflare Email Service's suppression list API
 * (src/email/suppressions.ts), answering the requests that module makes the
 * way the real API documents them: an `{ success, result }` envelope, and an
 * exact-address `email` filter on the list call.
 *
 * `handle` returns null for any other URL, so a test can combine it with
 * other fakes in one `fetch` spy.
 */

import type { Suppression } from "../../src/email/suppressions";

const PATH = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/email\/sending\/suppressions(?:\/([^/?]+))?(?:\?(.*))?$/;

export interface FakeSuppressionList {
  rows: Suppression[];
  /** Every request, as `METHOD path`, so a test can say what was asked. */
  requests: string[];
  /** Answers with an API error instead, for every request. */
  failWith?: string;
  handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null;
}

export function fakeSuppressionList(rows: Suppression[] = []): FakeSuppressionList {
  let nextId = 1;
  const list: FakeSuppressionList = {
    rows,
    requests: [],
    handle(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      const match = url.match(PATH);
      if (!match) return null;
      const method = init?.method ?? "GET";
      list.requests.push(`${method} ${url.slice(url.indexOf("/suppressions"))}`);
      return (async () => {
        if (list.failWith) {
          return Response.json({ success: false, errors: [{ message: list.failWith }], result: null }, { status: 500 });
        }
        const [, , id, query] = match;
        if (method === "GET") {
          const email = new URLSearchParams(query ?? "").get("email");
          return Response.json({ success: true, result: list.rows.filter((r) => !email || r.email === email) });
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as { email: string };
          const row = { id: `sup-${nextId++}`, email: body.email, reason: "manual", read_only: false };
          list.rows.push(row);
          return Response.json({ success: true, result: { id: row.id } });
        }
        if (method === "DELETE") {
          list.rows = list.rows.filter((r) => r.id !== decodeURIComponent(id));
          return Response.json({ success: true, result: { id } });
        }
        return new Response("unexpected method", { status: 405 });
      })();
    },
  };
  return list;
}
