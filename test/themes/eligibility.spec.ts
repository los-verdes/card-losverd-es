import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
import {
  getThemeOptions,
  membershipYears,
  themeDefaultsSince,
  themeOptions,
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

const LAUNCH = Date.parse("2027-01-01T00:00:00Z");
const BEFORE_LAUNCH = LAUNCH - 1;

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
    cardCreatedAt: BEFORE_LAUNCH,
  };

  it("offers classic, then each published year theme from a year the member was active, in year order", () => {
    // 2025 was an active year too, but has no theme.
    expect(ids(themeOptions(history, null, THEMES).themes)).toEqual(["classic", "2021", "2022", "2024"]);
  });

  it("offers the member-since year even when it is before the first order", () => {
    const options = themeOptions({ ...history, memberSince: "2019-02-01" }, null, THEMES);
    expect(ids(options.themes)).toEqual(["classic", "2019", "2021", "2022", "2024"]);
  });

  it("offers only classic to somebody with no orders and no member-since date", () => {
    const options = themeOptions({ orders: [], memberSince: null, cardCreatedAt: LAUNCH }, LAUNCH, THEMES);
    expect(ids(options.themes)).toEqual(["classic"]);
    expect(options.defaultTheme).toBe(CLASSIC_THEME);
  });

  it("starts every card in classic while no launch date is set", () => {
    expect(themeOptions({ ...history, cardCreatedAt: LAUNCH + 1 }, null, THEMES).defaultTheme).toBe(CLASSIC_THEME);
  });

  it("keeps a card created before launch in classic", () => {
    expect(themeOptions(history, LAUNCH, THEMES).defaultTheme).toBe(CLASSIC_THEME);
  });

  it("starts a card created on or after launch in its member-since year's theme", () => {
    expect(themeOptions({ ...history, cardCreatedAt: LAUNCH }, LAUNCH, THEMES).defaultTheme).toBe(Y2021);
  });

  it("falls back to classic when the member-since year has no theme", () => {
    const options = themeOptions(
      { orders: [order("2023-02-01", "2024-02-01")], memberSince: "2023-02-01", cardCreatedAt: LAUNCH },
      LAUNCH,
      THEMES,
    );
    expect(ids(options.themes)).toEqual(["classic", "2024"]);
    expect(options.defaultTheme).toBe(CLASSIC_THEME);
  });

  it("offers only classic from the real registry, which has no year themes yet", () => {
    expect(themeOptions({ ...history, cardCreatedAt: LAUNCH }, LAUNCH)).toEqual({
      themes: [CLASSIC_THEME],
      defaultTheme: CLASSIC_THEME,
    });
  });
});

describe("themeDefaultsSince", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "   "])("is off when unset (%j)", (value) => {
    expect(themeDefaultsSince(value)).toBeNull();
  });

  it("reads a date as the start of that day, UTC", () => {
    expect(themeDefaultsSince(" 2027-01-01 ")).toBe(LAUNCH);
  });

  it.each(["2027-1-1", "January 2027", "2027-13-45"])("is off, and says so, for %j", (value) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(themeDefaultsSince(value)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CARD_THEME_DEFAULTS_SINCE"), { value });
  });
});

describe("getThemeOptions", () => {
  const EMAIL = "pat@example.com";

  afterEach(async () => {
    env.CARD_THEME_DEFAULTS_SINCE = "";
    await env.DB.exec("DELETE FROM membership_orders");
    await env.DB.exec("DELETE FROM members");
  });

  async function insertMember(createdAt: number) {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, member_since, auth_token, last_updated_at, created_at)
       VALUES ('BC-1', 'Pat', 'Lee', ?, '2021-07-04', 'token', 1, ?)`,
    )
      .bind(EMAIL, createdAt)
      .run();
  }

  async function insertOrder(orderId: string, status: string, createdOn: string, expiresOn: string) {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES (?, 'bigcommerce', ?, ?, ?, ?, ?, 'sync')`,
    )
      .bind(orderId, EMAIL, EMAIL, status, `${createdOn}T12:00:00Z`, `${expiresOn}T12:00:00Z`)
      .run();
  }

  it("counts only orders that count as a membership", async () => {
    await insertMember(BEFORE_LAUNCH);
    await insertOrder("1001", "Completed", "2021-07-04", "2022-07-04");
    await insertOrder("1002", "Refunded", "2024-05-01", "2025-05-01");

    const options = await getThemeOptions(env, { member_id: "BC-1", member_since: "2021-07-04" }, THEMES);

    expect(ids(options.themes)).toEqual(["classic", "2021", "2022"]);
  });

  it("uses the member-since date it is given, which carries any correction", async () => {
    await insertMember(BEFORE_LAUNCH);

    const options = await getThemeOptions(env, { member_id: "BC-1", member_since: "2019-02-01" }, THEMES);

    expect(ids(options.themes)).toEqual(["classic", "2019"]);
  });

  it("starts a card in its member-since year's theme once created on or after the launch date", async () => {
    env.CARD_THEME_DEFAULTS_SINCE = "2027-01-01";
    await insertMember(LAUNCH);
    await insertOrder("1001", "Completed", "2021-07-04", "2022-07-04");

    const options = await getThemeOptions(env, { member_id: "BC-1", member_since: "2021-07-04" }, THEMES);

    expect(options.defaultTheme).toBe(Y2021);
  });

  it("keeps an earlier card in classic after launch", async () => {
    env.CARD_THEME_DEFAULTS_SINCE = "2027-01-01";
    await insertMember(BEFORE_LAUNCH);
    await insertOrder("1001", "Completed", "2021-07-04", "2022-07-04");

    const options = await getThemeOptions(env, { member_id: "BC-1", member_since: "2021-07-04" }, THEMES);

    expect(options.defaultTheme).toBe(CLASSIC_THEME);
  });

  it("offers the real registry by default", async () => {
    await insertMember(BEFORE_LAUNCH);

    expect(await getThemeOptions(env, { member_id: "BC-1", member_since: "2021-07-04" })).toEqual({
      themes: [CLASSIC_THEME],
      defaultTheme: CLASSIC_THEME,
    });
  });

  it("refuses a member who is not on record", async () => {
    await expect(getThemeOptions(env, { member_id: "BC-404", member_since: null })).rejects.toThrow("No member BC-404");
  });
});
