import { describe, expect, it } from "vitest";
import { buildBindingMessage, formatAddress } from "../../src/email/cloudflare";
import type { EmailMessage } from "../../src/email/send";

const MESSAGE: EmailMessage = {
  from: { email: "verde-bot@example.test", name: "Los Verdes" },
  to: { email: "member@example.com", name: "Jane Doe" },
  subject: "Your membership card",
  text: "Your card is attached.",
  html: "<p>Your card is attached.</p>",
};

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

  it("passes headers through, and leaves them off when there are none", () => {
    const headers = { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };

    expect(buildBindingMessage({ ...MESSAGE, headers }).headers).toEqual(headers);
    expect(buildBindingMessage(MESSAGE)).not.toHaveProperty("headers");
  });

  it("leaves attachments out entirely when there are none", () => {
    // Rather than an empty list, which is a claim that there are attachments
    // and they are nothing.
    expect(buildBindingMessage(MESSAGE)).not.toHaveProperty("attachments", []);
    expect(buildBindingMessage(MESSAGE).attachments).toBeUndefined();
  });
});
