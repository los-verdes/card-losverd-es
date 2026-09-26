import "./setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../src/auth/session";
import { FAVICON_SVG, STAGING_FAVICON_SVG } from "../src/assets";
import {
  STAGING_BANNER_TEXT,
  UNKNOWN_ENVIRONMENT_BANNER_TEXT,
  currentSiteEnvironment,
  siteEnvironment,
  titlePrefix,
} from "../src/environment";
import { PRIVACY_PATH } from "../src/member/privacy";
import worker from "../src/index";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const PRODUCTION = env.ENVIRONMENT;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(ADMIN_ID, "admin@example.com")
    .run();
});

afterEach(async () => {
  env.ENVIRONMENT = PRODUCTION;
  await env.DB.exec("DELETE FROM users");
});

async function get(path: string, signedIn = false) {
  const headers: HeadersInit = {};
  if (signedIn) {
    const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
    headers.Cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  const res = await worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
  return { status: res.status, body: await res.text() };
}

const memberPage = () => get(PRIVACY_PATH);
const adminPage = () => get("/admin/reports", true);
const PRODUCTION_LABEL = '<span class="env-label">Production</span>';

describe("siteEnvironment", () => {
  it.each([
    ["production", "production"],
    ["staging", "staging"],
    ["Production", "unknown"],
    ["prod", "unknown"],
    [" production", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const)("reads %j as %s", (value, expected) => {
    expect(siteEnvironment(value)).toBe(expected);
  });
});

describe("outside a request", () => {
  it("knows no environment, so shows nothing", () => {
    expect(currentSiteEnvironment()).toBeNull();
    expect(titlePrefix()).toBe("");
  });
});

describe("on production", () => {
  it("shows members nothing new", async () => {
    const { status, body } = await memberPage();

    expect(status).toBe(200);
    expect(body).toContain("<title>Privacy | Los Verdes</title>");
    expect(body).not.toContain("env-banner");
    expect(body).not.toContain(PRODUCTION_LABEL);
  });

  it("labels the admin nav Production, and shows no banner", async () => {
    const { status, body } = await adminPage();

    expect(status).toBe(200);
    expect(body).toContain(PRODUCTION_LABEL);
    expect(body).not.toContain("env-banner");
    expect(body).toMatch(/<title>[^[<]*\| Los Verdes Admin<\/title>/);
  });

  it("serves the verde favicon", async () => {
    expect((await get("/assets/favicon.svg")).body).toBe(FAVICON_SVG);
  });
});

describe("on staging", () => {
  beforeEach(() => {
    env.ENVIRONMENT = "staging";
  });

  it("puts a banner and a [Staging] title on member pages", async () => {
    const { body } = await memberPage();

    expect(body).toContain(`<div class="env-banner" role="note">${STAGING_BANNER_TEXT}</div>`);
    expect(body).toContain("<title>[Staging] Privacy | Los Verdes</title>");
  });

  it("puts them on admin pages, without the Production label", async () => {
    const { body } = await adminPage();

    expect(body).toContain(STAGING_BANNER_TEXT);
    expect(body).toMatch(/<title>\[Staging\] [^<]*\| Los Verdes Admin<\/title>/);
    expect(body).not.toContain(PRODUCTION_LABEL);
  });

  it("serves the black favicon", async () => {
    expect((await get("/assets/favicon.svg")).body).toBe(STAGING_FAVICON_SVG);
  });
});

describe.each([
  ["missing", undefined],
  ["misspelled", "Production"],
])("with ENVIRONMENT %s", (_label, value) => {
  beforeEach(() => {
    env.ENVIRONMENT = value as string;
  });

  it("shows the unknown-environment banner rather than passing for production", async () => {
    for (const { body } of [await memberPage(), await adminPage()]) {
      expect(body).toContain(UNKNOWN_ENVIRONMENT_BANNER_TEXT);
      expect(body).toContain("<title>[Unknown environment] ");
      expect(body).not.toContain(PRODUCTION_LABEL);
    }
  });

  it("serves the black favicon", async () => {
    expect((await get("/assets/favicon.svg")).body).toBe(STAGING_FAVICON_SVG);
  });
});
