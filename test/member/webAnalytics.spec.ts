import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { OUTCOMES, recordOutcome } from "../../src/lib/outcome";
import { WEB_ANALYTICS_BEACON_SRC, WebAnalyticsBeacon } from "../../src/member/webAnalytics";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";

const SESSION_KEY = "test-session-signing-key-0123456789";
const TOKEN = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.WEB_ANALYTICS_TOKEN = TOKEN;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM users");
});

async function get(path: string, cookie?: string) {
  const res = await worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
  return res.text();
}

describe("the Web Analytics beacon", () => {
  it("is on member-facing pages, carrying this environment's site token", async () => {
    const html = await get("/login");

    expect(html).toContain(`<script defer="" src="${WEB_ANALYTICS_BEACON_SRC}"`);
    expect(html).toContain(`data-cf-beacon="{&quot;token&quot;:&quot;${TOKEN}&quot;}"`);
  });

  it("is left out entirely when the environment has no token", async () => {
    env.WEB_ANALYTICS_TOKEN = "";

    expect(await get("/login")).not.toContain("cloudflareinsights");
  });

  it("is not on admin pages, whose handful of visitors would drown the traffic it is for", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (1, 'admin@example.com', 1)").run();
    const token = await issueSessionToken(SESSION_KEY, { userId: 1, isAdmin: true });

    expect(await get("/admin/members", `${SESSION_COOKIE_NAME}=${token}`)).not.toContain("cloudflareinsights");
  });

  it("renders nothing outside a request, where there is no environment to read", () => {
    expect(WebAnalyticsBeacon({})).toBeNull();
  });
});

describe("recordOutcome", () => {
  it("logs one object, so every field is queryable in Workers Logs", () => {
    const spy = spyOnOutcomes();

    recordOutcome("card.viewed", { admin: false });

    expect(spy).toHaveBeenCalledWith({ outcome: "card.viewed", admin: false });
    expect(outcomesFrom(spy)).toHaveLength(1);
  });

  it("keeps to a closed vocabulary of dotted names", () => {
    for (const outcome of OUTCOMES) expect(outcome).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length);
  });
});
