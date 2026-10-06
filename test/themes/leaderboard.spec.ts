import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIC_THEME, type CardTheme } from "../../src/themes/cardTheme";
import { themeLeaderboard } from "../../src/themes/leaderboard";

const Y2021: CardTheme = { ...CLASSIC_THEME, id: "2021", label: "2021 scarf", year: 2021 };
const Y2024: CardTheme = { ...CLASSIC_THEME, id: "2024", label: "2024 scarf", year: 2024 };
const THEMES = [CLASSIC_THEME, Y2021, Y2024];
const TODAY = "2026-10-06";

async function addMember(id: string, expires: string, theme?: string) {
  const email = `${id.toLowerCase()}@example.com`;
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at)
     VALUES (?, 'Test', 'Member', ?, ?, 'token', 1)`,
  )
    .bind(id, email, expires)
    .run();
  if (theme) {
    await env.DB.prepare("INSERT INTO member_card_themes (email, theme_id, source) VALUES (?, ?, 'member')")
      .bind(email, theme)
      .run();
  }
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM member_card_themes");
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM expelled_people");
  await env.DB.exec("DELETE FROM members");
});

describe("themeLeaderboard", () => {
  it("counts the members who have not picked as default, and the rest by the theme they picked, most first", async () => {
    await addMember("BC-1", "2027-01-01");
    await addMember("BC-2", "2027-01-01", "2024");
    await addMember("BC-3", "2027-01-01", "2024");
    await addMember("BC-4", "2026-10-06", "2021");

    expect(await themeLeaderboard(env, TODAY, THEMES)).toEqual({
      total: 4,
      tallies: [
        { theme: Y2024, members: 2 },
        { theme: null, members: 1 },
        { theme: Y2021, members: 1 },
      ],
    });
  });

  it("leaves out lapsed, revoked and expelled members, and themes nobody carries", async () => {
    await addMember("BC-1", "2027-01-01", "2021");
    await addMember("BC-2", "2026-10-05", "2024");
    await addMember("BC-3", "2027-01-01", "2024");
    await addMember("BC-4", "2027-01-01", "2024");
    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('BC-3')").run();
    await env.DB.prepare("INSERT INTO expelled_people (email) VALUES ('bc-4@example.com')").run();

    expect(await themeLeaderboard(env, TODAY, THEMES)).toEqual({
      total: 1,
      tallies: [{ theme: Y2021, members: 1 }],
    });
  });

  it("counts a choice of a theme no longer listed as default, since that is how the card is drawn", async () => {
    await addMember("BC-1", "2027-01-01", "withdrawn");
    await addMember("BC-2", "2027-01-01");

    expect(await themeLeaderboard(env, TODAY, THEMES)).toEqual({
      total: 2,
      tallies: [{ theme: null, members: 2 }],
    });
  });

  it("is empty when nobody's membership is current", async () => {
    expect(await themeLeaderboard(env, TODAY, THEMES)).toEqual({ total: 0, tallies: [] });
  });
});
