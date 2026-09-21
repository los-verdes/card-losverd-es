import { describe, expect, it } from "vitest";
import { issueSessionToken } from "../../src/auth/session";
import {
  issueUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "../../src/email/unsubscribeToken";
import { issueClaimToken } from "../../src/member/claimToken";

const KEY = "test-session-signing-key-0123456789";

describe("the unsubscribe token", () => {
  it("names the address it was issued for, lower-cased", async () => {
    const token = await issueUnsubscribeToken(KEY, "Jane@Example.com");

    expect(await verifyUnsubscribeToken(KEY, token)).toBe("jane@example.com");
  });

  it("keeps working however old it is", async () => {
    // It carries no expiry at all, so there is nothing for time to break: a
    // link has to work from an email that sat in an inbox for a year.
    const token = await issueUnsubscribeToken(KEY, "jane@example.com");
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

    expect(payload).not.toHaveProperty("exp");
  });

  it("rejects a token signed with another key, or altered", async () => {
    const token = await issueUnsubscribeToken(KEY, "jane@example.com");

    expect(await verifyUnsubscribeToken("another-key-entirely-0123456789", token)).toBeNull();
    expect(await verifyUnsubscribeToken(KEY, `${token}x`)).toBeNull();
    expect(await verifyUnsubscribeToken(KEY, "")).toBeNull();
  });

  it("is not interchangeable with the other tokens signed with the same key", async () => {
    // A session or a claim link must not unsubscribe anyone, which is what
    // the separate `sub` values are for.
    const session = await issueSessionToken(KEY, { userId: 1, isAdmin: false });
    const claim = await issueClaimToken(KEY, { userId: 1, memberId: "BC-1" });

    expect(await verifyUnsubscribeToken(KEY, session)).toBeNull();
    expect(await verifyUnsubscribeToken(KEY, claim)).toBeNull();
  });

  it("fails loudly, not as a bad link, when the key is unset", async () => {
    await expect(issueUnsubscribeToken("", "jane@example.com")).rejects.toThrow(/SESSION_SIGNING_KEY/);
    await expect(verifyUnsubscribeToken("", "anything")).rejects.toThrow(/SESSION_SIGNING_KEY/);
  });

  it("builds its link on the site's public origin", async () => {
    const url = await unsubscribeUrl(
      { PUBLIC_BASE_URL: "https://staging.example.test/", SESSION_SIGNING_KEY: KEY },
      "jane@example.com",
    );

    expect(url).toMatch(/^https:\/\/staging\.example\.test\/email\/unsubscribe\?token=[\w.-]+$/);
    const token = new URL(url).searchParams.get("token")!;
    expect(await verifyUnsubscribeToken(KEY, token)).toBe("jane@example.com");
  });
});
