import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildImportSql,
  buildImportStatements,
  parseLegacyExport,
  type LegacyExport,
} from "../../src/legacy/import-sql";

const SERIAL = "0cd5ad74-5fbc-40fd-9569-747fec277013";

const SQUARESPACE_ORDER = {
  order_id: "5f00000000000000000000a1",
  source: "squarespace",
  order_number: "1042",
  channel_name: "web",
  order_email: "o'brien@example.com",
  member_email: "pat@example.com",
  first_name: "Pat",
  last_name: "O'Brien",
  customer_id: null,
  sku: "SQ0000001",
  product_name: "Test Membership",
  status: "FULFILLED",
  test_mode: false,
  created_on: "2021-05-04T12:00:00Z",
  modified_on: "2021-05-05T01:02:03Z",
};

const BIGCOMMERCE_ORDER = {
  order_id: "1001_bc",
  source: "bigcommerce",
  order_number: "1001_00000000-0000-4000-8000-000000000001",
  channel_name: "bigcommerce_www",
  order_email: "early@example.com",
  member_email: "early@example.com",
  first_name: "Early",
  last_name: "Bird",
  customer_id: 42,
  sku: "LOSV-MEM-0001",
  product_name: "Los Verdes Annual Membership",
  status: "Completed",
  test_mode: false,
  created_on: "2023-03-10T08:30:00Z",
  modified_on: null,
};

function orderExport(order: Record<string, unknown>): Record<string, unknown> {
  return validExport({ membership_orders: [order], membership_orders_total: 1 });
}

function validExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 2,
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
    membership_orders_total: 3,
    membership_orders: [SQUARESPACE_ORDER, BIGCOMMERCE_ORDER],
    ...overrides,
  };
}

async function runImport(data: LegacyExport) {
  for (const statement of buildImportStatements(data)) {
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

async function lastUpdatedAt(email: string): Promise<number> {
  return (await env.DB.prepare("SELECT last_updated_at FROM members WHERE email = ?")
    .bind(email)
    .first<{ last_updated_at: number }>())!.last_updated_at;
}

async function overrides() {
  return (
    await env.DB.prepare("SELECT email, member_since, source, note FROM member_since_overrides ORDER BY email").all()
  ).results;
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM member_since_overrides");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM legacy_membership_cards");
  await env.DB.exec("DELETE FROM membership_order_attributions");
  await env.DB.exec("DELETE FROM membership_orders");
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

  it("accepts a real leap day, so the strictness isn't over-strict", () => {
    const parsed = parseLegacyExport(
      validExport({ member_since: [{ email: "a@example.com", member_since: "2020-02-29" }] }),
    );

    expect(parsed.member_since[0].member_since).toBe("2020-02-29");
  });

  it("treats missing optional card fields as null", () => {
    const parsed = parseLegacyExport(
      validExport({ membership_cards: [{ serial_number: SERIAL, email: "a@example.com" }] }),
    );
    expect(parsed.membership_cards[0].full_name).toBeNull();
  });

  it.each<[string, unknown, RegExp]>([
    ["non-object", [], /\$: expected a JSON object/],
    ["unknown format_version", validExport({ format_version: 3 }), /format_version/],
    ["a version 1 export, with a hint to re-export", validExport({ format_version: 1 }), /re-run scripts\/legacy-export\/export\.sql/],
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
    ["orders not an array", validExport({ membership_orders: "none" }), /membership_orders: expected an array/],
    ["order row not an object", orderExport([] as unknown as Record<string, unknown>), /membership_orders\[0\]: expected an object/],
    ["order without an id", orderExport({ ...SQUARESPACE_ORDER, order_id: "" }), /membership_orders\[0\]\.order_id/],
    ["unknown order source", orderExport({ ...SQUARESPACE_ORDER, source: "shopify" }), /bigcommerce or squarespace/],
    ["upper-case order_email", orderExport({ ...SQUARESPACE_ORDER, order_email: "Pat@example.com" }), /order_email: expected a lower-cased/],
    ["missing member_email", orderExport({ ...SQUARESPACE_ORDER, member_email: null }), /member_email/],
    ["fractional customer_id", orderExport({ ...BIGCOMMERCE_ORDER, customer_id: 4.2 }), /customer_id: expected an integer/],
    ["string customer_id", orderExport({ ...BIGCOMMERCE_ORDER, customer_id: "42" }), /customer_id/],
    ["non-boolean test_mode", orderExport({ ...SQUARESPACE_ORDER, test_mode: "f" }), /test_mode: expected a boolean/],
    ["date-only created_on", orderExport({ ...SQUARESPACE_ORDER, created_on: "2021-06-26" }), /created_on: expected YYYY-MM-DDTHH:MM:SSZ/],
    ["impossible created_on", orderExport({ ...SQUARESPACE_ORDER, created_on: "2021-13-45T00:00:00Z" }), /created_on/],
    // Date.parse accepts these and silently rolls them forward -- 30 February
    // becomes 2 March -- so a shaped-but-unreal date would otherwise import
    // and move the membership's expiry with it.
    ["rolled-over created_on", orderExport({ ...SQUARESPACE_ORDER, created_on: "2021-02-30T00:00:00Z" }), /created_on/],
    ["rolled-over member_since", validExport({ member_since: [{ email: "a@example.com", member_since: "2021-02-30" }] }), /YYYY-MM-DD/],
    ["29 February in a common year", validExport({ member_since: [{ email: "a@example.com", member_since: "2021-02-29" }] }), /YYYY-MM-DD/],
    ["bad modified_on", orderExport({ ...SQUARESPACE_ORDER, modified_on: "yesterday" }), /modified_on/],
    [
      "duplicate order id",
      validExport({ membership_orders: [SQUARESPACE_ORDER, SQUARESPACE_ORDER] }),
      /duplicate order 5f00000000000000000000a1/,
    ],
    ["missing orders total", validExport({ membership_orders_total: undefined }), /membership_orders_total/],
    ["fractional orders total", validExport({ membership_orders_total: 2.5 }), /membership_orders_total/],
    ["orders total smaller than the rows exported", validExport({ membership_orders_total: 1 }), /membership_orders_total/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseLegacyExport(input)).toThrow(message);
  });
});

describe("buildImportStatements (executed against D1)", () => {
  it("loads legacy dates as 'legacy_postgres' overrides and legacy cards, quoting apostrophes safely", async () => {
    await runImport(parseLegacyExport(validExport()));

    expect(await overrides()).toEqual([
      { email: "early@example.com", member_since: "2018-03-01", source: "legacy_postgres", note: null },
      { email: "o'brien@example.com", member_since: "2021-07-04", source: "legacy_postgres", note: null },
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

  it("is idempotent, and a re-run with corrected data overwrites earlier imported rows", async () => {
    const data = parseLegacyExport(validExport());
    await runImport(data);
    await runImport(data);
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM member_since_overrides) AS s, (SELECT COUNT(*) FROM legacy_membership_cards) AS c",
    ).first();
    expect(counts).toEqual({ s: 2, c: 1 });

    await runImport(
      parseLegacyExport(
        validExport({
          member_since: [{ email: "early@example.com", member_since: "2017-01-01" }],
          membership_cards: [{ serial_number: SERIAL, email: "new@example.com", full_name: "New Name" }],
        }),
      ),
    );
    expect((await overrides())[0]).toMatchObject({ email: "early@example.com", member_since: "2017-01-01" });
    expect(await env.DB.prepare("SELECT email, full_name, member_until FROM legacy_membership_cards").first()).toEqual({
      email: "new@example.com",
      full_name: "New Name",
      member_until: null,
    });
  });

  it("never overwrites a manual override", async () => {
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source, note) VALUES ('early@example.com', '2015-05-05', 'manual', 'founding member')",
    ).run();

    await runImport(parseLegacyExport(validExport()));

    expect((await overrides())[0]).toEqual({
      email: "early@example.com",
      member_since: "2015-05-05",
      source: "manual",
      note: "founding member",
    });
  });

  it("doesn't modify members rows directly", async () => {
    await insertMember("BC-1", "early@example.com", "2024-01-15");

    await runImport(parseLegacyExport(validExport()));

    const member = await env.DB.prepare("SELECT member_since FROM members WHERE email = 'early@example.com'").first();
    expect(member).toEqual({ member_since: "2024-01-15" });
  });

  it("loads Squarespace and BigCommerce orders into membership_orders, with a 365-day expiry", async () => {
    await runImport(parseLegacyExport(validExport()));

    const { results } = await env.DB.prepare("SELECT * FROM membership_orders ORDER BY created_on").all();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      order_id: "5f00000000000000000000a1",
      source: "squarespace",
      order_number: "1042",
      order_email: "o'brien@example.com",
      member_email: "pat@example.com",
      last_name: "O'Brien",
      customer_id: null,
      status: "FULFILLED",
      test_mode: 0,
      created_on: "2021-05-04T12:00:00Z",
      expires_on: "2022-05-04T12:00:00Z",
      modified_on: "2021-05-05T01:02:03Z",
      first_seen_via: "legacy_postgres",
    });
    expect(results[1]).toMatchObject({
      order_id: "1001_bc",
      source: "bigcommerce",
      customer_id: 42,
      modified_on: null,
      // 2024 is a leap year, so 365 days lands a day "early".
      expires_on: "2024-03-09T08:30:00Z",
    });
  });

  it("treats missing optional order fields as null, and keeps the test-order flag", async () => {
    await runImport(
      parseLegacyExport(
        orderExport({
          order_id: "abc123",
          source: "squarespace",
          order_email: "a@example.com",
          member_email: "a@example.com",
          test_mode: true,
          created_on: "2020-01-01T00:00:00Z",
        }),
      ),
    );

    expect(await env.DB.prepare("SELECT * FROM membership_orders").first()).toMatchObject({
      order_number: null,
      channel_name: null,
      first_name: null,
      sku: null,
      status: null,
      modified_on: null,
      test_mode: 1,
    });
  });

  it("for an order the BigCommerce sync already recorded, only fills in member_email", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES ('1001_bc', 'bigcommerce', 'early@example.com', 'early@example.com', 'Refunded', '2023-03-10T08:30:00Z', '2024-03-09T08:30:00Z', 'sync')`,
    ).run();

    await runImport(
      parseLegacyExport(orderExport({ ...BIGCOMMERCE_ORDER, member_email: "renamed@example.com" })),
    );

    expect(await env.DB.prepare("SELECT * FROM membership_orders").first()).toMatchObject({
      member_email: "renamed@example.com",
      status: "Refunded", // the sync's fresher status survives the older export
      first_seen_via: "sync",
    });
  });

  it("never overwrites the member_email of an order an admin has attributed", async () => {
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, status, created_on, expires_on, first_seen_via)
       VALUES ('1001_bc', 'bigcommerce', 'early@example.com', 'gift.recipient@example.com', 'Completed', '2023-03-10T08:30:00Z', '2024-03-09T08:30:00Z', 'sync')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO membership_order_attributions (order_id, previous_member_email, member_email)
       VALUES ('1001_bc', 'early@example.com', 'gift.recipient@example.com')`,
    ).run();

    await runImport(
      parseLegacyExport(orderExport({ ...BIGCOMMERCE_ORDER, member_email: "renamed@example.com" })),
    );

    expect(await env.DB.prepare("SELECT member_email FROM membership_orders").first()).toEqual({
      member_email: "gift.recipient@example.com",
    });
  });

  it("handles an empty export", async () => {
    const empty = parseLegacyExport(
      validExport({ member_since: [], membership_cards: [], membership_orders: [], membership_orders_total: 0 }),
    );
    expect(buildImportStatements(empty)).toEqual([]);
  });
});

describe("member_since_overrides triggers", () => {
  it("bump the matching member's last_updated_at on insert, update, and delete", async () => {
    await insertMember("BC-1", "early@example.com", null);
    await insertMember("BC-2", "other@example.com", null);

    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('early@example.com', '2018-03-01', 'manual')",
    ).run();
    const afterInsert = await lastUpdatedAt("early@example.com");
    expect(afterInsert).toBeGreaterThan(1);
    expect(Number.isInteger(afterInsert)).toBe(true);
    expect(await lastUpdatedAt("other@example.com")).toBe(1);

    await env.DB.exec("UPDATE members SET last_updated_at = 1");
    await env.DB.prepare("UPDATE member_since_overrides SET member_since = '2017-01-01' WHERE email = 'early@example.com'").run();
    expect(await lastUpdatedAt("early@example.com")).toBeGreaterThan(1);

    await env.DB.exec("UPDATE members SET last_updated_at = 1");
    await env.DB.prepare("DELETE FROM member_since_overrides WHERE email = 'early@example.com'").run();
    expect(await lastUpdatedAt("early@example.com")).toBeGreaterThan(1);
    expect(await lastUpdatedAt("other@example.com")).toBe(1);
  });

  it("bump both members when an override's email is changed", async () => {
    await insertMember("BC-1", "old@example.com", null);
    await insertMember("BC-2", "new@example.com", null);
    await env.DB.prepare(
      "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('old@example.com', '2018-03-01', 'manual')",
    ).run();
    await env.DB.exec("UPDATE members SET last_updated_at = 1");

    await env.DB.prepare("UPDATE member_since_overrides SET email = 'new@example.com' WHERE email = 'old@example.com'").run();

    expect(await lastUpdatedAt("old@example.com")).toBeGreaterThan(1);
    expect(await lastUpdatedAt("new@example.com")).toBeGreaterThan(1);
  });

  it("reject an unknown source", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO member_since_overrides (email, member_since, source) VALUES ('a@example.com', '2018-03-01', 'guess')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });
});

describe("buildImportSql", () => {
  it("renders a header comment and one terminated statement per line", () => {
    const sql = buildImportSql(parseLegacyExport(validExport()));
    const lines = sql.trimEnd().split("\n");
    expect(lines[0]).toBe("-- Generated from a legacy Postgres export taken at 2026-09-16T20:00:00Z.");
    expect(lines[1]).toBe("-- 2 member_since rows, 1 membership cards, 2 of 3 membership orders.");
    expect(lines.slice(2)).toHaveLength(5);
    expect(lines.slice(2).every((l) => l.endsWith(";"))).toBe(true);
  });
});
