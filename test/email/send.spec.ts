import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_ANY_RECIPIENT,
  allowsRecipient,
  parseRecipientAllowlist,
  sendEmail,
  type EmailMessage,
} from "../../src/email/send";
import { fakeEmailBinding, recipientOf } from "../fixtures/emailBinding";

afterEach(() => {
  vi.restoreAllMocks();
});

const MESSAGE: EmailMessage = {
  from: { email: "verde-bot@losverd.es", name: "Los Verdes (verde-bot)" },
  to: { email: "jane@example.com", name: "Jane Doe" },
  subject: "Subject",
  text: "plain",
  html: "<p>html</p>",
};

describe("sendEmail", () => {
  it("sends through the binding", async () => {
    const binding = fakeEmailBinding();

    await sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE);

    expect(binding.send).toHaveBeenCalledOnce();
    expect(recipientOf(binding.sent[0])).toBe("jane@example.com");
  });

  it("fails closed, naming what is missing, when the environment has no binding", async () => {
    await expect(sendEmail({ EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE)).rejects.toThrow(
      /no Cloudflare Email Service binding/,
    );
  });

  it("reports a sent message as sent", async () => {
    await expect(
      sendEmail({ EMAIL: fakeEmailBinding(), EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE),
    ).resolves.toBe("sent");
  });

  it("treats an unsubscribed recipient as suppressed, not failed, and logs it without the address", async () => {
    // The binding throws for an address on the suppression list. That is the
    // list working, so it must not read as a delivery failure anywhere.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await sendEmail(
      { EMAIL: fakeEmailBinding({ suppressed: true }), EMAIL_RECIPIENT_ALLOWLIST: "*" },
      MESSAGE,
    );

    expect(outcome).toBe("suppressed");
    expect(warnSpy).toHaveBeenCalledWith(
      "Email suppressed: recipient is on the account's suppression list",
      { subject: "Subject" },
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("jane@example.com");
  });

  it("says which service rejected a message", async () => {
    const binding = fakeEmailBinding({ failWith: "domain not onboarded" });

    await expect(
      sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE),
    ).rejects.toThrow(/Cloudflare Email Service send failed: .*domain not onboarded/);
  });
});

describe("who an environment may email", () => {
  it.each([
    ["*", "anyone@example.com", true],
    ["", "anyone@example.com", false],
    ["losverd.es", "card-test@losverd.es", true],
    ["losverd.es", "card-test+expired@losverd.es", true],
    ["losverd.es", "someone@example.com", false],
    ["someone@example.com", "someone@example.com", true],
    ["someone@example.com", "another@example.com", false],
    ["losverd.es, ops@example.com", "ops@example.com", true],
    ["losverd.es ops@example.com", "ops@example.com", true],
    ["LosVerd.ES", "Card-Test@LOSVERD.es", true],
  ])("allowlist %j permits %s -> %s", (list, address, expected) => {
    expect(allowsRecipient(list, address)).toBe(expected);
  });

  it("means nobody when unset, in every environment", () => {
    // The value reads the same wherever it is read: an environment that
    // loses this var goes quiet rather than open, and production carries `*`
    // explicitly rather than inheriting permission from an empty default.
    expect(allowsRecipient(undefined, "anyone@example.com")).toBe(false);
  });

  it("does not let a listed domain match a longer one that ends with it", () => {
    // Suffix matching would quietly make `verd.es` cover `losverd.es`, and an
    // allow-list matching more than it appears to is worse than none.
    expect(allowsRecipient("verd.es", "someone@losverd.es")).toBe(false);
    expect(allowsRecipient("losverd.es", "someone@mail.losverd.es")).toBe(false);
  });

  it("parses commas, whitespace and stray empties", () => {
    expect(parseRecipientAllowlist(" a@x.com ,, b.com  c@y.com ")).toEqual([
      "a@x.com",
      "b.com",
      "c@y.com",
    ]);
    expect(parseRecipientAllowlist("")).toEqual([]);
    expect(parseRecipientAllowlist(undefined)).toEqual([]);
  });

  it("exports the wildcard rather than spelling it in each caller", () => {
    expect(ALLOW_ANY_RECIPIENT).toBe("*");
  });
});

describe("suppressing a send", () => {
  it("does not call the binding for a recipient this environment may not email", async () => {
    // The guard against a bulk send lives above the transport on purpose:
    // a way out of this codebase that skipped it would be the whole risk
    // back again.
    const binding = fakeEmailBinding();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "losverd.es" }, MESSAGE);

    expect(binding.send).not.toHaveBeenCalled();
  });

  it("always says so in the log, and never writes the address down", async () => {
    // The case this is for: someone testing delivery from staging long after
    // this was added, finding nothing arrives, and having no idea why. The
    // address itself is withheld because a suppressed recipient is exactly
    // the one that might be a real member's.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ EMAIL: fakeEmailBinding(), EMAIL_RECIPIENT_ALLOWLIST: "losverd.es" }, MESSAGE);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Email suppressed"),
      expect.objectContaining({ recipientDomain: "example.com", allowlist: "losverd.es" }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("jane@example.com");
  });

  it("says plainly when the list is empty, rather than looking unconfigured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ EMAIL: fakeEmailBinding(), EMAIL_RECIPIENT_ALLOWLIST: "" }, MESSAGE);

    expect(warnSpy.mock.calls[0][1]).toMatchObject({ allowlist: "(empty -- nobody)" });
  });

  it("suppresses rather than throwing, even with no binding at all", async () => {
    // It runs inside `waitUntil` and inside the queue consumer. Throwing
    // would dead-letter a message, or fail a member-visible request, for
    // something working exactly as configured -- and the allow-list is
    // checked first, so an environment that may email nobody never needs a
    // binding to say so.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendEmail({ EMAIL_RECIPIENT_ALLOWLIST: "" }, MESSAGE)).resolves.toBe("suppressed");
  });
});
