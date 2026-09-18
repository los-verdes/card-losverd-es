import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { APPLE_DOMAIN_ASSOCIATION_PATH } from "../src/wellKnown";

/**
 * Apple is particular about how it fetches this file, and every one of its
 * requirements is a way for verification to fail silently: a redirect, a
 * wrong content type, an empty body that reads as a mismatch rather than as
 * "not configured". The assertions below are those requirements, not a
 * restatement of the implementation.
 */

const CONTENTS = '{"webcredentials":{"apps":["EXAMPLETEAM.example.app"]}}';

function get(path = APPLE_DOMAIN_ASSOCIATION_PATH) {
  return worker.fetch(
    new Request(`https://card-losverd-es-staging.jeff-hogan1.workers.dev${path}`, {
      redirect: "manual",
    }),
    env,
    createExecutionContext(),
  );
}

afterEach(() => {
  env.APPLE_DOMAIN_ASSOCIATION = undefined;
});

describe("the Apple domain-association file", () => {
  it("is served as plain text, with no redirect, when configured", async () => {
    env.APPLE_DOMAIN_ASSOCIATION = CONTENTS;

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe(CONTENTS);
  });

  it("is reachable without logging in", async () => {
    // Apple arrives as an anonymous client. Anything that sent it to /login
    // would fail verification with no indication why.
    env.APPLE_DOMAIN_ASSOCIATION = CONTENTS;

    expect((await get()).status).toBe(200);
  });

  it("trims surrounding whitespace a copy-paste picks up", async () => {
    env.APPLE_DOMAIN_ASSOCIATION = `\n  ${CONTENTS}\n`;

    expect(await (await get()).text()).toBe(CONTENTS);
  });

  it("404s rather than serving an empty body when unconfigured", async () => {
    // An empty 200 reads to Apple as a file whose contents don't match,
    // which is a worse diagnosis than the file being absent.
    expect((await get()).status).toBe(404);
  });

  it("404s when the value is only whitespace", async () => {
    env.APPLE_DOMAIN_ASSOCIATION = "   ";

    expect((await get()).status).toBe(404);
  });

  it("serves nothing else under /.well-known", async () => {
    env.APPLE_DOMAIN_ASSOCIATION = CONTENTS;

    expect((await get("/.well-known/anything-else.txt")).status).toBe(404);
  });
});
