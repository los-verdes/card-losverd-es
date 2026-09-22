/**
 * Last-resort handler for errors no route handled itself (`app.onError` in
 * src/index.ts) -- e.g. a secret that was never set. The full error goes to
 * the logs (kept by Workers Logs); a person gets a plain apology page instead
 * of a bare 500, and other clients (PassKit devices, BigCommerce webhooks) a
 * plain-text 500, since only the status matters to them.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../index";
import { Page, SUPPORT_EMAIL } from "../member/layout";
import { recordOpsEvent } from "../ops/events";

export async function handleServerError(err: Error, c: Context<{ Bindings: Env }>): Promise<Response> {
  // Deliberate responses thrown as exceptions (e.g. hono/csrf's 403).
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Cloudflare's Ray ID ties a report from a member to the matching log line.
  const rayId = c.req.header("cf-ray");
  console.error("Unhandled error", {
    method: c.req.method,
    // Path only: query strings can carry signatures.
    path: c.req.path,
    rayId,
    error: err.stack ?? String(err),
  });

  // Counted as well as logged, so the hourly watch can see a rate rather
  // than a line (src/ops/watch.ts). The path only, never the query string.
  // Awaited rather than deferred: this runs only on a 500, and a count that
  // depends on the request not being cancelled is not a count.
  await recordOpsEvent(c.env, "unhandled_error", `${c.req.method} ${c.req.path}`);

  c.header("Cache-Control", "no-store");
  if (!c.req.header("accept")?.includes("text/html")) {
    return c.text("Internal Server Error", 500);
  }
  return c.html(
    <Page title="Something went wrong">
      <h1>Something went wrong</h1>
      <p>Sorry, that didn't work on our end. Please try again in a few minutes.</p>
      <p>
        If it keeps happening, email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        {rayId && (
          <>
            {" "}
            and include this reference: <code>{rayId}</code>
          </>
        )}
        .
      </p>
      <p>
        <a href="/">Back to the start</a>
      </p>
    </Page>,
    500,
  );
}
