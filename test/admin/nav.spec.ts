import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)")
    .bind(ADMIN_ID, "admin@example.com")
    .run();
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM users");
});

async function get(path: string) {
  const token = await issueSessionToken(SESSION_KEY, { userId: ADMIN_ID, isAdmin: true });
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      redirect: "manual",
    }),
    env,
    createExecutionContext(),
  );
}

/** Every `href` inside the admin shell's `<nav>`. */
function navLinks(html: string): string[] {
  const nav = html.match(/<nav class="admin-nav">([\s\S]*?)<\/nav>/);
  expect(nav, "the admin shell should render a nav").not.toBeNull();
  return [...nav![1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe("the admin navigation", () => {
  it("points every link at something that exists", async () => {
    // The failure this catches is a link added alongside a route that landed
    // in a different pull request, or outlived one that was renamed. Neither
    // shows up in a type check, and both look fine until somebody clicks.
    const html = await (await get("/admin/reports")).text();
    const links = navLinks(html);
    expect(links.length).toBeGreaterThan(8);

    const statuses = await Promise.all(
      links.map(async (href) => [href, (await get(href)).status] as const),
    );

    expect(statuses.filter(([, status]) => status === 404)).toEqual([]);
  });

  it("groups the links rather than running them together", async () => {
    // Eleven links in one row read as a wall. Each group carries the shared
    // word so the links inside it only say what makes them different.
    const html = await (await get("/admin/reports")).text();

    const labels = [...html.matchAll(/class="nav-label">([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Reports", "Needs a look", "Members", "This environment"]);
  });

  it("is on every admin page, not just the reports index", async () => {
    for (const path of ["/admin/members", "/admin/member-since", "/admin/revocations"]) {
      const html = await (await get(path)).text();
      expect(navLinks(html).length, `${path} should carry the nav`).toBeGreaterThan(8);
    }
  });
});
