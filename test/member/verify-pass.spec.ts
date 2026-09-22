import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { signPassSerial } from "../../src/lib/passSignature";
import { outcomesFrom, spyOnOutcomes } from "../fixtures/outcomes";

const PASS_KEY = "test-pass-signature-key".repeat(5);
const SESSION_KEY = "test-session-signing-key-0123456789";
const LEGACY_SERIAL = "0cd5ad74-5fbc-40fd-9569-747fec277013";

beforeEach(() => {
  env.PASS_SIGNATURE_KEY = PASS_KEY;
  env.PASS_SIGNATURE_KEY_PREVIOUS = undefined;
  env.SESSION_SIGNING_KEY = SESSION_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM legacy_membership_cards");
  // Before `members`, which it references.
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

type Viewer = "anonymous" | "member" | "admin";

/**
 * Defaults to an admin, the one viewer who sees the full detail (revoked as
 * distinct from lapsed, and the date); the public view has tests of its own.
 */
async function verify(serial: string, signature?: string, viewer: Viewer = "admin") {
  const url = new URL(`https://card.losverd.es/verify-pass/${serial}`);
  if (signature !== undefined) url.searchParams.set("signature", signature);
  const headers = new Headers();
  if (viewer !== "anonymous") {
    await env.DB.prepare("INSERT OR REPLACE INTO users (id, email, is_admin) VALUES (1, 'viewer@example.com', ?)")
      .bind(viewer === "admin" ? 1 : 0)
      .run();
    const token = await issueSessionToken(SESSION_KEY, { userId: 1, isAdmin: viewer === "admin" });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(new Request(url, { headers, redirect: "manual" }), env, createExecutionContext());
}

async function signedVerify(serial: string, viewer: Viewer = "admin") {
  return verify(serial, await signPassSerial(PASS_KEY, serial), viewer);
}

async function insertMember(fields: {
  memberId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  expirationDate: string;
}) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, 'token', 1)`,
  )
    .bind(
      fields.memberId,
      fields.firstName ?? "Jane",
      fields.lastName ?? "Doe",
      fields.email,
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
  it("answers without signing in, uncached and unindexed", async () => {
    // Whoever checks a card at a door should not have to sign in first; the
    // signature is what stops a stranger opening an arbitrary card.
    await insertMember({ memberId: "BC-1", email: "jane@example.com", expirationDate: "2099-01-01" });

    const res = await signedVerify("BC-1", "anonymous");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain("MEMBERSHIP VALID");
    expect(html).toContain("Good through Jan 1, 2099");
  });

  it.each<Viewer>(["anonymous", "member"])(
    "tells a %s visitor only that a lapsed or revoked card is not current, with no date to tell them apart",
    async (viewer) => {
      await insertMember({ memberId: "BC-1", email: "lapsed@example.com", expirationDate: "2021-06-01" });
      await insertMember({ memberId: "BC-2", email: "revoked@example.com", expirationDate: "2099-01-01" });
      await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES ('BC-2')").run();

      for (const serial of ["BC-1", "BC-2"]) {
        const html = await (await signedVerify(serial, viewer)).text();

        expect(html).toContain("NOT A CURRENT MEMBERSHIP");
        expect(html).toContain("This card is genuine");
        expect(html).not.toMatch(/REVOKED|revoked|EXPIRED|Expired /);
      }
    },
  );

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

  it("says a revoked card is revoked, in the code of conduct's word", async () => {
    await insertMember({ memberId: "BC-1", email: "jane@example.com", expirationDate: "2099-01-01" });
    await env.DB.prepare("INSERT INTO revoked_cards (member_id) VALUES (?)").bind("BC-1").run();

    const html = await (await signedVerify("BC-1")).text();

    expect(html).toContain("MEMBERSHIP REVOKED");
    expect(html).toContain("this membership has been revoked");
    // Nothing to be good through, and not something renewing would fix.
    expect(html).not.toContain("Good through");
    expect(html).not.toContain("MEMBERSHIP EXPIRED");
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
      `INSERT INTO members (member_id, first_name, last_name, email, expiration_date, auth_token, last_updated_at)
       VALUES ('BC-9', '', ' ', 'blank@example.com', NULL, 'token', 1)`,
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

  describe("while PASS_SIGNATURE_KEY is being rotated", () => {
    const RETIRED_KEY = PASS_KEY;
    const NEW_KEY = "test-rotated-signature-key".repeat(5);

    beforeEach(async () => {
      env.PASS_SIGNATURE_KEY = NEW_KEY;
      env.PASS_SIGNATURE_KEY_PREVIOUS = RETIRED_KEY;
      await insertLegacyCard("jane@example.com", "2099-01-01");
    });

    it("still verifies a card signed with the retired key", async () => {
      const warnings: unknown[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        const res = await verify(LEGACY_SERIAL, await signPassSerial(RETIRED_KEY, LEGACY_SERIAL));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("MEMBERSHIP VALID");
      } finally {
        console.warn = warn;
      }
      // The signal that says when the rotation can be finished.
      expect(warnings.join("\n")).toContain("PASS_SIGNATURE_KEY_PREVIOUS");
      expect(warnings.join("\n")).not.toContain(LEGACY_SERIAL);
    });

    it("verifies a card signed with the new key", async () => {
      const res = await verify(LEGACY_SERIAL, await signPassSerial(NEW_KEY, LEGACY_SERIAL));
      expect(res.status).toBe(200);
    });

    it("rejects the retired key once the rotation is finished", async () => {
      env.PASS_SIGNATURE_KEY_PREVIOUS = undefined;
      const res = await verify(LEGACY_SERIAL, await signPassSerial(RETIRED_KEY, LEGACY_SERIAL));
      expect(res.status).toBe(403);
    });
  });
});

describe("what a scan records", () => {
  it("says whether the card came from the previous site, and how the check went", async () => {
    // Legacy QR codes are the oldest thing still in circulation at cutover;
    // how often they are scanned, and how they fare, is the question.
    await insertLegacyCard("jane@example.com", "2020-01-01");
    await insertMember({ memberId: "LV-00000000-0000-4000-8000-000000000001", email: "jane@example.com", expirationDate: "2099-01-01" });
    const spy = spyOnOutcomes();

    await signedVerify(LEGACY_SERIAL);
    await signedVerify("LV-00000000-0000-4000-8000-000000000001");
    await verify("LV-00000000-0000-4000-8000-000000000001", "forged");
    await signedVerify("LV-no-such-card");

    expect(outcomesFrom(spy)).toEqual([
      { outcome: "pass.verified", result: "active", card: "legacy", key: "current" },
      { outcome: "pass.verified", result: "active", card: "current", key: "current" },
      { outcome: "pass.verified", result: "bad_signature", card: "current" },
      { outcome: "pass.verified", result: "not_found", card: "current", key: "current" },
    ]);
  });
});
