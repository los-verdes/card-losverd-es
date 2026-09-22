import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/session";
import worker from "../../src/index";
import { handleServerError } from "../../src/lib/serverError";

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function appThatThrows(error: Error) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.get("/boom", () => {
    throw error;
  });
  app.onError(handleServerError);
  return app;
}

describe("handleServerError", () => {
  it("shows a person an apology page with the support email and the Ray ID", async () => {
    const res = await appThatThrows(new Error("kaboom")).request("/boom?signature=abc", {
      headers: { accept: "text/html,application/xhtml+xml", "cf-ray": "8c1e2f3a4b5c6d7e-DFW" },
    }, env);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).toContain("mailto:merchteam@losverdesatx.org");
    expect(body).toContain("<code>8c1e2f3a4b5c6d7e-DFW</code>");
    expect(body).not.toContain("kaboom");
  });

  it("logs the full error with the path (not the query string) and the Ray ID", async () => {
    await appThatThrows(new Error("kaboom")).request("/boom?signature=abc", {
      headers: { accept: "text/html", "cf-ray": "8c1e2f3a4b5c6d7e-DFW" },
    }, env);

    expect(consoleError).toHaveBeenCalledWith("Unhandled error", {
      method: "GET",
      path: "/boom",
      rayId: "8c1e2f3a4b5c6d7e-DFW",
      error: expect.stringContaining("kaboom"),
    });
  });

  it("leaves out the reference when there is no Ray ID", async () => {
    const res = await appThatThrows(new Error("kaboom")).request("/boom", { headers: { accept: "text/html" } }, env);

    expect(await res.text()).not.toContain("reference");
  });

  it("logs a thrown value without a stack", async () => {
    const error = new Error("no stack");
    error.stack = undefined;

    await appThatThrows(error).request("/boom", undefined, env);

    expect(consoleError).toHaveBeenCalledWith("Unhandled error", expect.objectContaining({ error: "Error: no stack" }));
  });

  it("gives clients that don't want HTML (devices, webhooks) a plain 500", async () => {
    const res = await appThatThrows(new Error("kaboom")).request("/boom", { headers: { accept: "application/json" } }, env);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("passes deliberate HTTP errors through untouched", async () => {
    const res = await appThatThrows(new HTTPException(403, { message: "Forbidden" })).request("/boom", {
      headers: { accept: "text/html" },
    }, env);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("the Worker's error handling", () => {
  const SESSION_KEY = env.SESSION_SIGNING_KEY;

  afterEach(() => {
    env.SESSION_SIGNING_KEY = SESSION_KEY;
  });

  // A session cookie with SESSION_SIGNING_KEY unset: the misconfiguration
  // first hit on staging, which fails closed by throwing.
  it.each(["/", "/admin/reports"])("shows the apology page, not a bare 500, for %s when a secret is missing", async (path) => {
    env.SESSION_SIGNING_KEY = "";

    const res = await worker.fetch(
      new Request(`https://card.losverd.es${path}`, {
        headers: { accept: "text/html", cookie: `${SESSION_COOKIE_NAME}=anything` },
      }),
      env,
      createExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Something went wrong");
    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled error",
      expect.objectContaining({ path, error: expect.stringContaining("SESSION_SIGNING_KEY is not configured") }),
    );
  });
});

describe("what the hourly watch counts", () => {
  // Cleared first, not last: every test in this file now reaches the counter.
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM ops_events");
  });

  afterEach(async () => {
    await env.DB.exec("DELETE FROM ops_events");
  });

  it("counts an unhandled error, with the path but not the query string", async () => {
    // The watch alerts on a rate of these (#56, src/ops/watch.ts); a line in
    // the logs alone is only found by somebody already looking.
    await appThatThrows(new Error("kaboom")).request("/boom?signature=abc", { headers: { accept: "text/html" } }, env);

    const rows = await env.DB.prepare("SELECT kind, detail FROM ops_events").all();
    expect(rows.results).toEqual([{ kind: "unhandled_error", detail: "GET /boom" }]);
  });

  it("does not count a deliberate HTTPException, which is a refusal rather than a fault", async () => {
    await appThatThrows(new HTTPException(403, { message: "Forbidden" })).request("/boom", undefined, env);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_events").first()).toEqual({ n: 0 });
  });
});
