import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { PRIVACY_PATH } from "../src/member/privacy";

const PRODUCTION = env.ENVIRONMENT;

afterEach(() => {
  env.ENVIRONMENT = PRODUCTION;
});

async function robotsTxt(environment: string) {
  env.ENVIRONMENT = environment;
  const res = await worker.fetch(
    new Request("https://card.losverd.es/robots.txt"),
    env,
    createExecutionContext(),
  );
  return { res, body: await res.text() };
}

/** Whether a crawler following the file's rules may fetch `path`: the longest
 * matching rule wins, `$` anchors the end, and an allow wins a tie. */
function allows(body: string, path: string): boolean {
  let best = { length: -1, allow: true };
  for (const line of body.split("\n")) {
    const match = /^(Allow|Disallow): (.*)$/.exec(line);
    if (!match) continue;
    const [, rule, pattern] = match;
    const anchored = pattern.endsWith("$");
    const prefix = anchored ? pattern.slice(0, -1) : pattern;
    const matches = anchored ? path === prefix : path.startsWith(prefix);
    const allow = rule === "Allow";
    if (matches && (pattern.length > best.length || (pattern.length === best.length && allow))) {
      best = { length: pattern.length, allow };
    }
  }
  return best.allow;
}

describe("/robots.txt", () => {
  it("answers as plain text, cached for a day, rather than 404", async () => {
    const { res } = await robotsTxt("production");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("on production, opens the sign-in page, the privacy policy and public images", async () => {
    const { body } = await robotsTxt("production");

    expect(body).toMatch(/^User-agent: \*$/m);
    for (const path of ["/", "/login", PRIVACY_PATH, "/assets/logo.png"]) {
      expect(allows(body, path), path).toBe(true);
    }
  });

  it("on production, closes everything behind a sign-in or a card's signature", async () => {
    const { body } = await robotsTxt("production");

    for (const path of [
      "/admin/reports",
      "/verify-pass/0000?signature=abc",
      "/email-card",
      "/card.png",
      "/login/complete",
      "/passkit/v1/passes",
      "/bigcommerce/order-webhook",
    ]) {
      expect(allows(body, path), path).toBe(false);
    }
  });

  it.each(["staging", "", "prod"])("asks crawlers to stay out of %j entirely", async (environment) => {
    const { body } = await robotsTxt(environment);

    expect(body).toBe("User-agent: *\nDisallow: /\n");
  });
});
