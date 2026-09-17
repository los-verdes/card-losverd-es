import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { signPassSerial } from "../../src/lib/passSignature";

const PASS_KEY = "test-pass-signature-key".repeat(5);
const SESSION_KEY = "test-session-signing-key-0123456789";
const LEGACY_SERIAL = "0cd5ad74-5fbc-40fd-9569-747fec277013";

beforeEach(() => {
  env.PASS_SIGNATURE_KEY = PASS_KEY;
  env.SESSION_SIGNING_KEY = SESSION_KEY;
});

afterEach(async () => {
  await env.DB.exec("DELETE FROM legacy_membership_cards");
  await env.DB.exec("DELETE FROM members");
});

async function verify(serial: string, signature?: string, loggedIn = true) {
  const url = new URL(`https://card.losverd.es/verify-pass/${serial}`);
  if (signature !== undefined) url.searchParams.set("signature", signature);
  const headers = new Headers();
  if (loggedIn) {
    const token = await issueSessionToken(SESSION_KEY, { userId: 1, isAdmin: false });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(new Request(url, { headers, redirect: "manual" }), env, createExecutionContext());
}

async function signedVerify(serial: string) {
  return verify(serial, await signPassSerial(PASS_KEY, serial));
}

async function insertMember(fields: {
  memberId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  status?: string;
  expirationDate: string;
}) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status, expiration_date, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'token', 1)`,
  )
    .bind(
      fields.memberId,
      fields.firstName ?? "Jane",
      fields.lastName ?? "Doe",
      fields.email,
      fields.status ?? "active",
      fields.expirationDate,
    )
    .run();
}

async function insertLegacyCard(email: string, memberUntil: string | null, fullName: string | null = "Jane Legacy") {
  await env.DB.prepare(
    `INSERT INTO legacy_membership_cards (serial_number, email, full_name, member_since, member_until)
     VALUES (?, ?, ?, '2019-01-01', ?)`,
  )
    .bind(LEGACY_SERIAL, email, fullName, memberUntil)
    .run();
}

describe("GET /verify-pass/:serial", () => {
  it("requires login", async () => {
    const res = await verify(LEGACY_SERIAL, await signPassSerial(PASS_KEY, LEGACY_SERIAL), false);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["wrong", "not-the-signature="],
  ])("rejects a %s signature", async (_label, signature) => {
    await insertLegacyCard("jane@example.com", "2099-01-01");
    const res = await verify(LEGACY_SERIAL, signature);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Unable to verify signature!");
  });

  it("returns 404 for a genuine signature on an unknown serial", async () => {
    const res = await signedVerify("no-such-card");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Card not found");
  });

  it("shows a legacy card holder's current membership, not the old card's dates", async () => {
    await insertLegacyCard("jane@example.com", "2020-01-01"); // the old card itself expired long ago
    await insertMember({
      memberId: "BC-1",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Renewed",
      expirationDate: "2099-03-04",
    });

    const res = await signedVerify(LEGACY_SERIAL);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("MEMBERSHIP VALID");
    expect(html).toContain("Jane Renewed");
    expect(html).toContain("Good through Mar 4, 2099");
  });

  it("shows a lapsed membership as expired, while confirming the card is genuine", async () => {
    await insertLegacyCard("jane@example.com", "2020-01-01");
    await insertMember({ memberId: "BC-1", email: "jane@example.com", expirationDate: "2021-06-01" });

    const html = await (await signedVerify(LEGACY_SERIAL)).text();

    expect(html).toContain("MEMBERSHIP EXPIRED");
    expect(html).toContain("This card is genuine");
    expect(html).toContain("Expired Jun 1, 2021");
  });

  it("treats a revoked member as not current", async () => {
    await insertMember({ memberId: "BC-1", email: "jane@example.com", status: "revoked", expirationDate: "2099-01-01" });
    expect(await (await signedVerify("BC-1")).text()).toContain("MEMBERSHIP EXPIRED");
  });

  it("verifies a new-stack card by member_id", async () => {
    await insertMember({
      memberId: "BC-42",
      email: "bo@example.com",
      firstName: "Bo",
      lastName: "Jones",
      expirationDate: "2099-01-01",
    });

    const html = await (await signedVerify("BC-42")).text();

    expect(html).toContain("MEMBERSHIP VALID");
    expect(html).toContain("Bo Jones");
  });

  it.each<[string, string, string]>([
    ["expired", "2020-01-01", "MEMBERSHIP EXPIRED"],
    ["still valid", "2099-01-01", "MEMBERSHIP VALID"],
  ])(
    "falls back to the legacy card's own dates when the holder was never synced (%s)",
    async (_label, memberUntil, expected) => {
      await insertLegacyCard("old-member@example.com", memberUntil, "Old Member");

      const html = await (await signedVerify(LEGACY_SERIAL)).text();

      expect(html).toContain(expected);
      expect(html).toContain("Old Member");
    },
  );

  it("omits the name and date lines when they're unknown", async () => {
    await insertLegacyCard("x@example.com", null, null);

    const html = await (await signedVerify(LEGACY_SERIAL)).text();

    expect(html).toContain("MEMBERSHIP EXPIRED");
    expect(html).not.toContain("Good through");
    expect(html).not.toContain("Expired ");
  });

  it("omits a blank member name, and treats a missing expiration as not current", async () => {
    await env.DB.prepare(
      `INSERT INTO members (member_id, first_name, last_name, email, status, expiration_date, auth_token, last_updated_at)
       VALUES ('BC-9', '', ' ', 'blank@example.com', 'active', NULL, 'token', 1)`,
    ).run();

    const html = await (await signedVerify("BC-9")).text();

    expect(html).toContain("MEMBERSHIP EXPIRED");
    expect(html).not.toContain('font-size: 1.5rem');
    expect(html).not.toContain("Expired ");
  });

  it("escapes member-provided text", async () => {
    await insertMember({
      memberId: "BC-1",
      email: "x@example.com",
      firstName: "<script>alert(1)</script>",
      lastName: "",
      expirationDate: "2099-01-01",
    });

    const html = await (await signedVerify("BC-1")).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("fails closed without PASS_SIGNATURE_KEY", async () => {
    env.PASS_SIGNATURE_KEY = "";
    const res = await verify(LEGACY_SERIAL, "anything");
    expect(res.status).toBe(500);
  });
});
