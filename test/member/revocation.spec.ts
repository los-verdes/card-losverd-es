import "../setup/d1";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveStatus,
  getMemberByEmail,
  getMemberById,
  isMembershipCurrent,
} from "../../src/member/artifacts";
import { lookupPassHolder } from "../../src/member/passHolder";
import { isRevoked, restoreCard, revokeCard, revokedCards } from "../../src/member/revocation";
import { refreshMemberFromOrders } from "../../src/bigcommerce/sync";
import { activeMemberships, ordersByMonth } from "../../src/admin/reportQueries";

const CARD = "LV-6f1c8e40-0000-4000-8000-a1b2c3d4e5f6";
const EMAIL = "jane@example.com";
const TODAY = "2026-06-01";

beforeEach(async () => {
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (1, ?, 1)")
    .bind("admin@example.com")
    .run();
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status,
       expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'active', '2099-03-04', '2021-07-15', 'token', 1)`,
  )
    .bind(CARD, EMAIL)
    .run();
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, first_name,
       last_name, sku, status, created_on, expires_on, first_seen_via)
     VALUES ('9001_bc', 'bigcommerce', ?, ?, 'Jane', 'Doe', 'LOSV-MEM-0001', 'Completed',
       '2026-01-15T00:00:00Z', '2099-01-15T00:00:00Z', 'sync')`,
  )
    .bind(EMAIL, EMAIL)
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM revoked_cards");
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
});

describe("revoking a membership", () => {
  it("is not in force beforehand", async () => {
    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(effectiveStatus(member, TODAY)).toBe("active");
    expect(isMembershipCurrent(member, TODAY)).toBe(true);
  });

  it("reads as revoked, with no expiry left to be good through", async () => {
    await revokeCard(env, CARD, "conduct", 1);

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(member.status).toBe("revoked");
    expect(member.expiration_date).toBeNull();
    expect(effectiveStatus(member, TODAY)).toBe("revoked");
    expect(isMembershipCurrent(member, TODAY)).toBe(false);
  });

  it("resolves the same by card number as by address", async () => {
    await revokeCard(env, CARD, null, 1);

    expect((await getMemberById(env, CARD))!.status).toBe("revoked");
  });

  it("leaves the orders underneath untouched", async () => {
    // The whole reason a withdrawal is its own table: lifting it has to put
    // the membership back to whatever the orders say, without remembering
    // what it used to be.
    await revokeCard(env, CARD, null, 1);
    await restoreCard(env, CARD);

    const member = (await getMemberByEmail(env, EMAIL))!;
    expect(member.status).toBe("active");
    expect(member.expiration_date).toBe("2099-03-04");
  });

  it("survives a sync that rewrites the member's derived state", async () => {
    // `deriveMembershipState()` recomputes `status` from orders and the
    // upsert writes it unconditionally, so a revocation stored on `members`
    // would be undone at the member's next order sync -- silently.
    await revokeCard(env, CARD, null, 1);

    await refreshMemberFromOrders(env, EMAIL, {
      firstName: "Jane",
      lastName: "Doe",
    });

    expect((await getMemberByEmail(env, EMAIL))!.status).toBe("revoked");
  });

  it("moves last_updated_at, so installed passes are told", async () => {
    // The fact lives outside `members`, so nothing else would move the
    // timestamp Apple's polling endpoint compares against.
    const before = await env.DB.prepare(
      "SELECT last_updated_at FROM members WHERE member_id = ?",
    )
      .bind(CARD)
      .first<{ last_updated_at: number }>();

    await revokeCard(env, CARD, null, 1);

    const after = await env.DB.prepare(
      "SELECT last_updated_at FROM members WHERE member_id = ?",
    )
      .bind(CARD)
      .first<{ last_updated_at: number }>();
    expect(after!.last_updated_at).toBeGreaterThan(before!.last_updated_at);
  });

  it("does not restamp a withdrawal that is already recorded", async () => {
    // Somebody else's decision, with their name and their reason on it.
    await revokeCard(env, CARD, "the original reason", 1);

    expect(await revokeCard(env, CARD, "a later hand", 1)).toBe(false);
    expect((await revokedCards(env))[0].note).toBe("the original reason");
  });

  it("says so rather than pretending, when there is nothing to restore", async () => {
    expect(await restoreCard(env, CARD)).toBe(false);
  });

  it("lists who withdrew it and why", async () => {
    await revokeCard(env, CARD, "conduct", 1);

    const [row] = await revokedCards(env);
    expect(row).toMatchObject({
      member_id: CARD,
      email: EMAIL,
      note: "conduct",
      revoked_by_email: "admin@example.com",
    });
    expect(await isRevoked(env, CARD)).toBe(true);
  });
});

describe("what a scanned card says", () => {
  it("calls a revoked membership revoked, not expired", async () => {
    // The card is genuine either way. Somebody holding one up is owed an
    // answer that does not sound like renewing would fix it.
    await revokeCard(env, CARD, null, 1);

    const holder = (await lookupPassHolder(env, CARD, TODAY))!;
    expect(holder.revoked).toBe(true);
    expect(holder.active).toBe(false);
    expect(holder.expirationDate).toBeNull();
  });

  it("does not call an ordinary lapse a withdrawal", async () => {
    const holder = (await lookupPassHolder(env, CARD, TODAY))!;
    expect(holder.revoked).toBe(false);
    expect(holder.active).toBe(true);
  });
});

describe("what the reports say", () => {
  it("stops listing them as a current member", async () => {
    // Otherwise the reports and the access checks tell different stories
    // about the same person, and whoever answers their next question is
    // reading the wrong one.
    expect((await activeMemberships(env.DB, "2026-06-01")).totalMembers).toBe(1);

    await revokeCard(env, CARD, null, 1);

    expect((await activeMemberships(env.DB, "2026-06-01")).totalMembers).toBe(0);
  });

  it("keeps what they bought in the sales history", async () => {
    // A withdrawal is a decision about a person. The order was still placed
    // and the money is still the group's; the books must not change because
    // somebody was asked to leave.
    const before = await ordersByMonth(env.DB, 2026);
    await revokeCard(env, CARD, null, 1);
    const after = await ordersByMonth(env.DB, 2026);

    expect(after).toEqual(before);
  });
});
