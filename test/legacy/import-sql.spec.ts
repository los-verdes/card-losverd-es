import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildImportSql,
  buildImportStatements,
  parseLegacyExport,
  type LegacyExport,
} from "../../src/legacy/import-sql";

const SERIAL = "0cd5ad74-5fbc-40fd-9569-747fec277013";

function validExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    exported_at: "2026-09-16T20:00:00Z",
    member_since: [
      { email: "early@example.com", member_since: "2018-03-01" },
      { email: "o'brien@example.com", member_since: "2021-07-04" },
    ],
    membership_cards: [
      {
        serial_number: SERIAL,
        email: "o'brien@example.com",
        full_name: "Pat O'Brien",
        member_since: "2021-07-04",
        member_until: "2022-07-04",
      },
    ],
    ...overrides,
  };
}

async function runImport(data: LegacyExport, nowMs = 1_800_000_000_000) {
  for (const statement of buildImportStatements(data, nowMs)) {
    await env.DB.prepare(statement).run();
  }
}

async function insertMember(memberId: string, email: string, memberSince: string | null) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, member_since, auth_token, last_updated_at)
     VALUES (?, 'A', 'B', ?, ?, 'token', 1)`,
  )
    .bind(memberId, email, memberSince)
    .run();
}

async function memberRow(email: string) {
  return env.DB.prepare("SELECT member_since, last_updated_at FROM members WHERE email = ?")
    .bind(email)
    .first<{ member_since: string | null; last_updated_at: number }>();
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM legacy_member_since");
  await env.DB.exec("DELETE FROM legacy_membership_cards");
});

describe("parseLegacyExport", () => {
  it("accepts a well-formed export, including null card fields", () => {
    const input = validExport({
      membership_cards: [
        { serial_number: SERIAL, email: "a@example.com", full_name: null, member_since: null, member_until: null },
      ],
    });
    expect(parseLegacyExport(input).membership_cards[0]).toEqual({
      serial_number: SERIAL,
      email: "a@example.com",
      full_name: null,
      member_since: null,
      member_until: null,
    });
  });

  it("treats missing optional card fields as null", () => {
    const parsed = parseLegacyExport(
      validExport({ membership_cards: [{ serial_number: SERIAL, email: "a@example.com" }] }),
    );
    expect(parsed.membership_cards[0].full_name).toBeNull();
  });

  it.each<[string, unknown, RegExp]>([
    ["non-object", [], /\$: expected a JSON object/],
    ["unknown format_version", validExport({ format_version: 2 }), /format_version/],
    ["missing exported_at", validExport({ exported_at: "" }), /exported_at/],
    ["free-text exported_at", validExport({ exported_at: "now\nDROP TABLE members" }), /exported_at/],
    ["member_since not an array", validExport({ member_since: {} }), /member_since: expected an array/],
    ["member_since row not an object", validExport({ member_since: ["x"] }), /member_since\[0\]/],
    ["upper-case email", validExport({ member_since: [{ email: "A@example.com", member_since: "2020-01-01" }] }), /lower-cased/],
    ["email without @", validExport({ member_since: [{ email: "nobody", member_since: "2020-01-01" }] }), /lower-cased email/],
    [
      "duplicate member_since email",
      validExport({
        member_since: [
          { email: "a@example.com", member_since: "2020-01-01" },
          { email: "a@example.com", member_since: "2019-01-01" },
        ],
      }),
      /duplicate email/,
    ],
    ["bad member_since date", validExport({ member_since: [{ email: "a@example.com", member_since: "03/01/2018" }] }), /YYYY-MM-DD/],
    ["cards not an array", validExport({ membership_cards: null }), /membership_cards: expected an array/],
    ["card row not an object", validExport({ membership_cards: [42] }), /membership_cards\[0\]/],
    ["non-UUID serial", validExport({ membership_cards: [{ serial_number: "17060213257243853049731934763545489427", email: "a@example.com" }] }), /UUID/],
    ["upper-case UUID serial", validExport({ membership_cards: [{ serial_number: SERIAL.toUpperCase(), email: "a@example.com" }] }), /UUID/],
    [
      "duplicate serial",
      validExport({
        membership_cards: [
          { serial_number: SERIAL, email: "a@example.com" },
          { serial_number: SERIAL, email: "b@example.com" },
        ],
      }),
      /duplicate serial/,
    ],
    ["non-string full_name", validExport({ membership_cards: [{ serial_number: SERIAL, email: "a@example.com", full_name: 7 }] }), /full_name/],
    ["bad member_until", validExport({ membership_cards: [{ serial_number: SERIAL, email: "a@example.com", member_until: "2022-07-04T00:00:00" }] }), /member_until/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseLegacyExport(input)).toThrow(message);
  });
});

describe("buildImportStatements (executed against D1)", () => {
  it("loads both legacy tables, quoting apostrophes safely", async () => {
    await runImport(parseLegacyExport(validExport()));

    const since = await env.DB.prepare("SELECT email, member_since FROM legacy_member_since ORDER BY email").all();
    expect(since.results).toEqual([
      { email: "early@example.com", member_since: "2018-03-01" },
      { email: "o'brien@example.com", member_since: "2021-07-04" },
    ]);
    const card = await env.DB.prepare("SELECT * FROM legacy_membership_cards").first();
    expect(card).toEqual({
      serial_number: SERIAL,
      email: "o'brien@example.com",
      full_name: "Pat O'Brien",
      member_since: "2021-07-04",
      member_until: "2022-07-04",
    });
  });

  it("is idempotent, and a re-run with corrected data overwrites", async () => {
    const data = parseLegacyExport(validExport());
    await runImport(data);
    await runImport(data);
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM legacy_member_since) AS s, (SELECT COUNT(*) FROM legacy_membership_cards) AS c",
    ).first();
    expect(counts).toEqual({ s: 2, c: 1 });

    const corrected = parseLegacyExport(
      validExport({
        member_since: [{ email: "early@example.com", member_since: "2017-01-01" }],
        membership_cards: [{ serial_number: SERIAL, email: "new@example.com", full_name: "New Name" }],
      }),
    );
    await runImport(corrected);
    expect(
      await env.DB.prepare("SELECT member_since FROM legacy_member_since WHERE email = 'early@example.com'").first(),
    ).toEqual({ member_since: "2017-01-01" });
    expect(await env.DB.prepare("SELECT email, full_name, member_until FROM legacy_membership_cards").first()).toEqual({
      email: "new@example.com",
      full_name: "New Name",
      member_until: null,
    });
  });

  it("backfills existing members' member_since only when the legacy date is earlier or missing", async () => {
    await insertMember("BC-1", "early@example.com", "2024-01-15"); // later than legacy -> moves earlier
    await insertMember("BC-2", "o'brien@example.com", "2020-01-01"); // already earlier -> untouched
    await insertMember("BC-3", "unrelated@example.com", null); // no legacy row -> untouched
    const now = 1_800_000_000_000;

    await runImport(parseLegacyExport(validExport()), now);

    expect(await memberRow("early@example.com")).toEqual({ member_since: "2018-03-01", last_updated_at: now });
    expect(await memberRow("o'brien@example.com")).toEqual({ member_since: "2020-01-01", last_updated_at: 1 });
    expect(await memberRow("unrelated@example.com")).toEqual({ member_since: null, last_updated_at: 1 });
  });

  it("fills a null members.member_since from the legacy date", async () => {
    await insertMember("LV-1", "early@example.com", null);
    await runImport(parseLegacyExport(validExport()));
    expect((await memberRow("early@example.com"))?.member_since).toBe("2018-03-01");
  });

  it("handles an empty export", async () => {
    const empty = parseLegacyExport(validExport({ member_since: [], membership_cards: [] }));
    expect(buildImportStatements(empty, 0)).toHaveLength(1);
    await runImport(empty);
  });
});

describe("buildImportSql", () => {
  it("renders a header comment and one terminated statement per line", () => {
    const sql = buildImportSql(parseLegacyExport(validExport()), 0);
    const lines = sql.trimEnd().split("\n");
    expect(lines[0]).toBe("-- Generated from a legacy Postgres export taken at 2026-09-16T20:00:00Z.");
    expect(lines[1]).toBe("-- 2 member_since rows, 1 membership cards.");
    expect(lines.slice(2)).toHaveLength(4);
    expect(lines.slice(2).every((l) => l.endsWith(";"))).toBe(true);
  });
});
