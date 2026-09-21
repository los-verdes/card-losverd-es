import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBindingMessage, formatAddress } from "../../src/email/cloudflare";
import { sendEmail, transportName, type EmailMessage } from "../../src/email/send";

afterEach(() => {
  vi.restoreAllMocks();
});

const MESSAGE: EmailMessage = {
  from: { email: "verde-bot@example.test", name: "Los Verdes" },
  to: { email: "member@example.com", name: "Jane Doe" },
  subject: "Your membership card",
  text: "Your card is attached.",
  html: "<p>Your card is attached.</p>",
};

/** A binding that records what it was handed, and can be told to fail. */
function fakeBinding(behaviour: "ok" | "throw" = "ok") {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (message: unknown) => {
      if (behaviour === "throw") throw new Error("domain not onboarded");
      sent.push(message);
    }),
  };
}

describe("choosing a transport", () => {
  it("prefers the binding when the environment has one", async () => {
    // An environment can hold both while it is being moved across, and the
    // binding is the one it is being moved to.
    const binding = fakeBinding();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await sendEmail(
      { EMAIL: binding, SENDGRID_API_KEY: "SG.still-here", EMAIL_RECIPIENT_ALLOWLIST: "*" },
      MESSAGE,
    );

    expect(binding.send).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to SendGrid for an environment with no binding", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 202 }));

    await sendEmail({ SENDGRID_API_KEY: "SG.test-key", EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("sendgrid.com");
  });

  it("refuses to send when an environment has neither", async () => {
    await expect(sendEmail({ EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE)).rejects.toThrow(
      /neither the Cloudflare Email Service binding nor SENDGRID_API_KEY/,
    );
  });

  it("reports which one a page should name", () => {
    expect(transportName({ EMAIL: fakeBinding() })).toBe("cloudflare");
    expect(transportName({ SENDGRID_API_KEY: "SG.x" })).toBe("sendgrid");
    expect(transportName({})).toBeNull();
  });
});

describe("the allow-list still governs the binding", () => {
  it("suppresses a recipient the environment may not email", async () => {
    // The guard against a bulk send lives above both transports on purpose.
    // A second way out of this codebase that skipped it would be the whole
    // risk back again.
    const binding = fakeBinding();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "losverd.es" }, MESSAGE);

    expect(binding.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("sends nothing at all when the list is empty", async () => {
    const binding = fakeBinding();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "" }, MESSAGE);

    expect(binding.send).not.toHaveBeenCalled();
  });
});

describe("the message handed to the binding", () => {
  it("folds a display name into the address, which the binding takes as one string", () => {
    expect(formatAddress({ email: "a@example.test", name: "Los Verdes" })).toBe(
      "Los Verdes <a@example.test>",
    );
    expect(formatAddress({ email: "a@example.test" })).toBe("a@example.test");
  });

  it("base64-encodes attachments and marks them as attachments", () => {
    const built = buildBindingMessage({
      ...MESSAGE,
      attachments: [
        { filename: "card.png", type: "image/png", content: new Uint8Array([1, 2, 3]) },
      ],
    });

    expect(built.attachments).toEqual([
      { content: "AQID", filename: "card.png", type: "image/png", disposition: "attachment" },
    ]);
  });

  it("carries both a text and an HTML body", () => {
    const built = buildBindingMessage(MESSAGE);

    expect(built.text).toBe("Your card is attached.");
    expect(built.html).toBe("<p>Your card is attached.</p>");
    expect(built.subject).toBe("Your membership card");
  });

  it("drops the unsubscribe group, which has no equivalent here", () => {
    // Recorded as a test rather than only a comment: this is a real
    // difference from SendGrid, and it should fail loudly if somebody adds a
    // field expecting it to be carried.
    const built = buildBindingMessage({ ...MESSAGE, unsubscribeGroupId: 42 });

    expect(built).not.toHaveProperty("asm");
    expect(JSON.stringify(built)).not.toContain("42");
  });
});

describe("when the binding rejects a message", () => {
  it("says which transport failed, since two are in play", async () => {
    const binding = fakeBinding("throw");

    await expect(
      sendEmail({ EMAIL: binding, EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE),
    ).rejects.toThrow(/Cloudflare Email Service send failed: .*domain not onboarded/);
  });
});
