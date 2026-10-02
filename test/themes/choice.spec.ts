import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemberByEmail } from "../../src/member/artifacts";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
import {
  ThemeNotAllowed,
  clearCardTheme,
  getCardThemeChoice,
  mayChooseTheme,
  resolveCardTheme,
  setCardTheme,
  themeChoiceOpenTo,
} from "../../src/themes/choice";

// Inlined at transform time; node:fs is not available in this pool.
const wranglerToml = Object.values(
  import.meta.glob("../../wrangler.toml", { query: "?raw", import: "default", eager: true }),
)[0] as string;

function yearTheme(year: number): CardTheme {
  return { ...CLASSIC_THEME, id: String(year), label: `${year} scarf`, year };
}

const Y2021 = yearTheme(2021);
const Y2024 = yearTheme(2024);
const Y2025 = yearTheme(2025);
const THEMES = [CLASSIC_THEME, Y2021, Y2024, Y2025];

const EMAIL = "jane@example.com";
const ADMIN_ID = 1;

async function member() {
  return (await getMemberByEmail(env, EMAIL))!;
}

async function audit() {
  const { results } = await env.DB.prepare("SELECT action, subject_email, actor_email, detail FROM audit_log ORDER BY id").all();
  return results;
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // no APNs configured here
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, member_since, auth_token, last_updated_at)
     VALUES ('LV-1', 'Jane', 'Doe', ?, '2025-07-15', '2021-07-15', 'token', 1)`,
  )
    .bind(EMAIL)
    .run();
  // Bought in 2021 and 2024, so those years' themes are hers; 2025 is not.
  for (const [id, created] of [["1001", "2021-07-15"], ["1002", "2024-07-15"]]) {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES (?, 'bigcommerce', ?, ?, 'Completed', ?, ?, 'sync')`,
    )
      .bind(id, EMAIL, EMAIL, `${created}T12:00:00Z`, `${Number(created.slice(0, 4)) + 1}${created.slice(4)}T12:00:00Z`)
      .run();
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.CARD_THEME_CHOICE = "admins";
  env.CARD_THEME_YEAR_DEFAULTS = "false";
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM member_card_themes");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("who may choose", () => {
  it.each([
    ["admins", "admins"],
    [" Everyone ", "everyone"],
    ["", "nobody"],
    ["all", "nobody"],
    [undefined, "nobody"],
  ] as const)("reads CARD_THEME_CHOICE %j as %s", async (value, openTo) => {
    env.CARD_THEME_CHOICE = value;

    expect(await themeChoiceOpenTo(env)).toBe(openTo);
  });

  it("lets admins choose before everyone else, and nobody at all when closed", async () => {
    env.CARD_THEME_CHOICE = "admins";
    expect([await mayChooseTheme(env, true), await mayChooseTheme(env, false)]).toEqual([true, false]);
    env.CARD_THEME_CHOICE = "everyone";
    expect([await mayChooseTheme(env, true), await mayChooseTheme(env, false)]).toEqual([true, true]);
    env.CARD_THEME_CHOICE = "off";
    expect([await mayChooseTheme(env, true), await mayChooseTheme(env, false)]).toEqual([false, false]);
  });

  it("is open to everyone, in both environments", () => {
    expect(wranglerToml.match(/^CARD_THEME_CHOICE = "everyone"$/gm)).toHaveLength(2);
  });
});

describe("choosing a theme", () => {
  it("stores the choice, says so in the audit log, and marks the card for its passes", async () => {
    await setCardTheme(env, await member(), "2024", "admin", ADMIN_ID, THEMES);

    expect(await getCardThemeChoice(env, EMAIL)).toMatchObject({ theme_id: "2024", source: "admin", set_by_email: "admin@example.com" });
    expect((await member()).card_theme).toBe("2024");
    expect(await audit()).toEqual([
      { action: "card_theme.set", subject_email: EMAIL, actor_email: "admin@example.com", detail: '"2024 scarf"' },
    ]);
    expect((await member()).last_updated_at).toBeGreaterThan(1);
  });

  it("records what an admin's choice replaced", async () => {
    await setCardTheme(env, await member(), "2021", "admin", ADMIN_ID, THEMES);
    await setCardTheme(env, await member(), "2024", "admin", ADMIN_ID, THEMES);

    expect((await audit())[1]).toMatchObject({ detail: '"2024 scarf" (was "2021 scarf")' });
  });

  it("leaves a member's choice for their own card out of the audit log, while still storing and sending it", async () => {
    await setCardTheme(env, await member(), "2024", "member", null, THEMES);
    await clearCardTheme(env, EMAIL, "member", null, THEMES);
    await setCardTheme(env, await member(), "2021", "member", null, THEMES);

    expect(await audit()).toEqual([]);
    expect(await getCardThemeChoice(env, EMAIL)).toMatchObject({ theme_id: "2021", source: "member" });
    expect((await member()).last_updated_at).toBeGreaterThan(1);
  });

  it("refuses a theme the member may not use, and stores nothing", async () => {
    await expect(setCardTheme(env, await member(), "2025", "member", null, THEMES)).rejects.toThrow(ThemeNotAllowed);
    await expect(setCardTheme(env, await member(), "no-such-theme", "admin", ADMIN_ID, THEMES)).rejects.toThrow(ThemeNotAllowed);

    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
    expect(await audit()).toEqual([]);
  });

  it("clears a choice, putting the card back to its default", async () => {
    await setCardTheme(env, await member(), "2024", "admin", ADMIN_ID, THEMES);

    await clearCardTheme(env, EMAIL, "admin", ADMIN_ID, THEMES);

    expect(await getCardThemeChoice(env, EMAIL)).toBeNull();
    expect((await audit())[1]).toMatchObject({ action: "card_theme.cleared", detail: 'Was "2024 scarf"' });
  });

  it("records nothing when there was nothing to clear", async () => {
    await clearCardTheme(env, EMAIL, "admin", ADMIN_ID, THEMES);

    expect(await audit()).toEqual([]);
  });
});

describe("the theme a card is drawn in", () => {
  it("is the member's choice", async () => {
    await setCardTheme(env, await member(), "2021", "member", null, THEMES);

    expect(await resolveCardTheme(env, await member(), THEMES)).toBe(Y2021);
  });

  it("is the default when nobody has chosen: classic, or the member-since year's once year defaults are on", async () => {
    expect(await resolveCardTheme(env, await member(), THEMES)).toBe(CLASSIC_THEME);

    env.CARD_THEME_YEAR_DEFAULTS = "true";
    expect(await resolveCardTheme(env, await member(), THEMES)).toBe(Y2021);
  });

  it("falls back to the default when the chosen theme can no longer be used, keeping the choice", async () => {
    await setCardTheme(env, await member(), "2024", "admin", ADMIN_ID, THEMES);
    const withdrawn = THEMES.filter((theme) => theme !== Y2024);

    expect(await resolveCardTheme(env, await member(), withdrawn)).toBe(CLASSIC_THEME);
    expect(await getCardThemeChoice(env, EMAIL)).not.toBeNull();
  });

  it("draws in classic from the real registry until year defaults are on, though 2021's theme is hers", async () => {
    expect(await resolveCardTheme(env, await member())).toBe(CLASSIC_THEME);

    env.CARD_THEME_YEAR_DEFAULTS = "true";
    expect((await resolveCardTheme(env, await member())).id).toBe("2021");
  });
});
