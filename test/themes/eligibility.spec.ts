import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
import {
  getThemeOptions,
  membershipYears,
  themeOptions,
  themeYearDefaultsEnabled,
} from "../../src/themes/eligibility";

function yearTheme(year: number): CardTheme {
  return { ...CLASSIC_THEME, id: String(year), label: String(year), year };
}

// Published themes for some years and not others, as there will be.
const Y2019 = yearTheme(2019);
const Y2021 = yearTheme(2021);
const Y2022 = yearTheme(2022);
const Y2024 = yearTheme(2024);
const THEMES = [CLASSIC_THEME, Y2024, Y2019, Y2022, Y2021];

function order(created_on: string, expires_on: string) {
  return { created_on: `${created_on}T12:00:00Z`, expires_on: `${expires_on}T12:00:00Z` };
}

const ids = (themes: CardTheme[]) => themes.map((theme) => theme.id);

describe("membershipYears", () => {
  it("covers every calendar year from the day an order was placed to the day it expired", () => {
    expect(membershipYears([order("2021-07-04", "2022-07-04")])).toEqual(new Set([2021, 2022]));
  });

  it("covers one year for an order that starts and ends in it", () => {
    expect(membershipYears([order("2024-01-01", "2024-12-31")])).toEqual(new Set([2024]));
  });

  it("combines several orders, counting a shared year once", () => {
    expect(
      membershipYears([order("2021-03-01", "2022-03-01"), order("2022-03-01", "2023-03-01")]),
    ).toEqual(new Set([2021, 2022, 2023]));
  });

  it("is empty without orders", () => {
    expect(membershipYears([])).toEqual(new Set());
  });
});

describe("themeOptions", () => {
  const history = {
    orders: [order("2021-07-04", "2022-07-04"), order("2024-05-01", "2025-05-01")],
    memberSince: "2021-07-04",
  };

  it("offers classic, then each published year theme from a year the member was active, in year order", () => {
    // 2025 was an active year too, but has no theme.
    expect(ids(themeOptions(history, false, THEMES).themes)).toEqual(["classic", "2021", "2022", "2024"]);
  });

  it("offers the member-since year even when it is before the first order", () => {
    const options = themeOptions({ ...history, memberSince: "2019-02-01" }, false, THEMES);
    expect(ids(options.themes)).toEqual(["classic", "2019", "2021", "2022", "2024"]);
  });

  it("offers only classic to somebody with no orders and no member-since date", () => {
    const options = themeOptions({ orders: [], memberSince: null }, true, THEMES);
    expect(ids(options.themes)).toEqual(["classic"]);
    expect(options.defaultTheme).toBe(CLASSIC_THEME);
  });

  it("keeps every card in classic while year defaults are off", () => {
    expect(themeOptions(history, false, THEMES).defaultTheme).toBe(CLASSIC_THEME);
  });

  it("draws a card in its member-since year's theme once year defaults are on", () => {
    expect(themeOptions(history, true, THEMES).defaultTheme).toBe(Y2021);
  });

  it("follows a corrected member-since date", () => {
    expect(themeOptions({ ...history, memberSince: "2019-02-01" }, true, THEMES).defaultTheme).toBe(Y2019);
  });

  it("falls back to classic when the member-since year has no theme", () => {
    const options = themeOptions(
      { orders: [order("2023-02-01", "2024-02-01")], memberSince: "2023-02-01" },
      true,
      THEMES,
    );
    expect(ids(options.themes)).toEqual(["classic", "2024"]);
    expect(options.defaultTheme).toBe(CLASSIC_THEME);
  });

  it("offers only classic from the real registry, which has no year themes yet", () => {
    expect(themeOptions(history, true)).toEqual({ themes: [CLASSIC_THEME], defaultTheme: CLASSIC_THEME });
  });
});

describe("themeYearDefaultsEnabled", () => {
  afterEach(() => {
    env.CARD_THEME_YEAR_DEFAULTS = "false";
  });

  it("is off as configured in wrangler.toml", async () => {
    expect(await themeYearDefaultsEnabled(env)).toBe(false);
  });

  it.each(["true", " TRUE ", "True"])("is on for %j", async (value) => {
    env.CARD_THEME_YEAR_DEFAULTS = value;
    expect(await themeYearDefaultsEnabled(env)).toBe(true);
  });

  it.each(["", "false", "yes", "1", undefined])("is off for %j", async (value) => {
    env.CARD_THEME_YEAR_DEFAULTS = value;
    expect(await themeYearDefaultsEnabled(env)).toBe(false);
  });
});

describe("getThemeOptions", () => {
  const EMAIL = "pat@example.com";
  const member = { email: EMAIL, member_since: "2021-07-04" };

  afterEach(async () => {
    env.CARD_THEME_YEAR_DEFAULTS = "false";
    await env.DB.exec("DELETE FROM membership_orders");
  });

  async function insertOrder(orderId: string, status: string, createdOn: string, expiresOn: string, email = EMAIL) {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES (?, 'bigcommerce', ?, ?, ?, ?, ?, 'sync')`,
    )
      .bind(orderId, email, email, status, `${createdOn}T12:00:00Z`, `${expiresOn}T12:00:00Z`)
      .run();
  }

  it("counts only this member's orders that count as a membership", async () => {
    await insertOrder("1001", "Completed", "2021-07-04", "2022-07-04");
    await insertOrder("1002", "Refunded", "2024-05-01", "2025-05-01");
    await insertOrder("1003", "Completed", "2019-03-01", "2020-03-01", "someone.else@example.com");

    expect(ids((await getThemeOptions(env, member, THEMES)).themes)).toEqual(["classic", "2021", "2022"]);
  });

  it("uses the member-since date it is given, which carries any correction", async () => {
    const options = await getThemeOptions(env, { ...member, member_since: "2019-02-01" }, THEMES);
    expect(ids(options.themes)).toEqual(["classic", "2019"]);
  });

  it("defaults to the member-since year's theme only once year defaults are on", async () => {
    await insertOrder("1001", "Completed", "2021-07-04", "2022-07-04");
    expect((await getThemeOptions(env, member, THEMES)).defaultTheme).toBe(CLASSIC_THEME);

    env.CARD_THEME_YEAR_DEFAULTS = "true";
    expect((await getThemeOptions(env, member, THEMES)).defaultTheme).toBe(Y2021);
  });

  it("offers the real registry by default", async () => {
    expect(await getThemeOptions(env, member)).toEqual({ themes: [CLASSIC_THEME], defaultTheme: CLASSIC_THEME });
  });
});
