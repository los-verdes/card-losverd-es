import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { getMemberByEmail, renderCardImage } from "../../src/member/artifacts";
import { THEME_PATH, currentFirst } from "../../src/member/portal";
import { YEAR_THEMES } from "../../src/themes/cardTheme";
import { getCardThemeChoice, setCardTheme } from "../../src/themes/choice";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";

const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const EMAIL = "jane@example.com";
// A member since 2021, so 2021's theme is hers and 2022's is not.
const Y2021 = YEAR_THEMES.find((theme) => theme.year === 2021)!;

async function makeAdmin(isAdmin: boolean) {
  await env.DB.prepare("UPDATE users SET is_admin = ? WHERE id = ?").bind(isAdmin ? 1 : 0, USER_ID).run();
}

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key-0123456789";
  vi.spyOn(console, "warn").mockImplementation(() => {}); // no APNs configured here
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, ?, 1)").bind(USER_ID, EMAIL).run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email,
       expiration_date, member_since, user_id, auth_token, last_updated_at)
     VALUES ('LV-1', 'Jane', 'Doe', ?, '2099-03-04', '2021-07-15', ?, 'token', 1)`,
  )
    .bind(EMAIL, USER_ID)
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.CARD_THEME_CHOICE = "admins";
  await env.DB.exec("DELETE FROM member_card_themes");
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

async function request(path: string, init: RequestInit = {}) {
  const token = await issueSessionToken(SESSION_KEY, { userId: USER_ID, isAdmin: false });
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  if (init.method === "POST") headers.set("Origin", "https://card.losverd.es");
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { ...init, headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return { method: "POST" as const, body };
}

describe("who is offered the choice", () => {
  it.each([
    ["admins", true, true],
    ["admins", false, false],
    ["everyone", false, true],
    ["off", true, false],
  ] as const)("with CARD_THEME_CHOICE %s, an admin %s: linked from the card page and open, %s", async (setting, isAdmin, offered) => {
    env.CARD_THEME_CHOICE = setting;
    await makeAdmin(isAdmin);

    expect((await (await request("/")).text()).includes(`href="${THEME_PATH}"`)).toBe(offered);
    expect((await request(THEME_PATH)).status).toBe(offered ? 200 : 404);
  });
});

describe("the theme page", () => {
  it("previews their own card in each theme they may use, marking the one it is in now", async () => {
    const body = await (await request(THEME_PATH)).text();

    expect(body).toContain('src="/card.png?theme=classic"');
    expect(body).toContain('src="/card.png?theme=2021"');
    expect(body).not.toContain("theme=2022");
    expect(body).toContain("Your card is drawn in <strong>Classic</strong>, the default.");
    expect(body.match(/Your card looks like this now\./g)).toHaveLength(1);
    expect(body).not.toContain("Go back to the default");
  });

  it("leads back to the card from the top, before the previews, as well as from the foot", async () => {
    const body = await (await request(THEME_PATH)).text();
    const top = body.indexOf('<a href="/">← Back to your card</a>');

    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(body.indexOf("<h1>"));
    expect(body).toContain('<a href="/">Back to your card</a>');
  });

  it("lists the theme the card is in now first, the rest in their usual order", async () => {
    const before = await (await request(THEME_PATH)).text();
    expect(before.indexOf("theme=classic")).toBeLessThan(before.indexOf("theme=2021"));

    await setCardTheme(env, (await getMemberByEmail(env, EMAIL))!, "2021", "member", USER_ID);

    const after = await (await request(THEME_PATH)).text();
    expect(after.indexOf("theme=2021")).toBeLessThan(after.indexOf("theme=classic"));
  });

  it("says when the theme is one they chose, and offers the default back", async () => {
    await setCardTheme(env, (await getMemberByEmail(env, EMAIL))!, "2021", "member", USER_ID);

    const body = await (await request(THEME_PATH)).text();

    expect(body).toContain("Your card is drawn in <strong>2021: Inaugural season</strong>, which you chose.");
    expect(body).toContain("Go back to the default (Classic)");
  });
});

describe("choosing", () => {
  it("saves their choice as their own, and says so", async () => {
    const outcomes = spyOnOutcomes();

    const res = await request(THEME_PATH, form({ theme: "2021" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${THEME_PATH}?saved=1`);
    expect(await getCardThemeChoice(env, EMAIL)).toMatchObject({ theme_id: "2021", source: "member", set_by_email: EMAIL });
    expect(outcomesFrom(outcomes)).toContainEqual({ outcome: "card_theme.saved", result: "set" });
    expect(await (await request(`${THEME_PATH}?saved=1`)).text()).toContain("Saved.");
  });

  it("refuses a theme that is not theirs, and stores nothing", async () => {
    const res = await request(THEME_PATH, form({ theme: "2022" }));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That theme isn&#39;t one your card can use.");
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });

  it("goes back to the default when asked", async () => {
    await request(THEME_PATH, form({ theme: "2021" }));

    const res = await request(THEME_PATH, form({ clear: "1" }));

    expect(res.status).toBe(303);
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });

  it("is refused to somebody who may not choose yet", async () => {
    await makeAdmin(false);

    expect((await request(THEME_PATH, form({ theme: "2021" }))).status).toBe(404);
    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
  });
});

describe("a preview of the card in another theme", () => {
  it("is their card, drawn in that theme", async () => {
    const res = await request("/card.png?theme=2021");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      await renderCardImage(env, (await getMemberByEmail(env, EMAIL))!, Y2021),
    );
  });

  it("is refused for a theme that is not theirs, or to somebody who may not choose yet", async () => {
    expect((await request("/card.png?theme=2022")).status).toBe(404);

    await makeAdmin(false);
    expect((await request("/card.png?theme=classic")).status).toBe(404);
    // Their own card, as it is, is unaffected.
    expect((await request("/card.png")).status).toBe(200);
  });
});

describe("currentFirst", () => {
  it("moves the current theme to the front and keeps the others' order", () => {
    const [a, b, c] = YEAR_THEMES;

    expect(currentFirst([a, b, c], c)).toEqual([c, a, b]);
    expect(currentFirst([a, b, c], a)).toEqual([a, b, c]);
  });
});
