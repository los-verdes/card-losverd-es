import { describe, expect, it } from "vitest";
import { buildBindingMessage, toBindingAddress } from "../../src/email/cloudflare";
import type { EmailMessage } from "../../src/email/send";

const MESSAGE: EmailMessage = {
  from: { email: "verde-bot@example.test", name: "Los Verdes" },
  to: { email: "member@example.com", name: "Jane Doe" },
  subject: "Your membership card",
  text: "Your card is attached.",
  html: "<p>Your card is attached.</p>",
};

describe("the message handed to the binding", () => {
  it("hands the binding an address in parts, never folded into one string", () => {
    expect(toBindingAddress({ email: "a@example.test", name: "Los Verdes" })).toEqual({
      email: "a@example.test",
      name: "Los Verdes",
    });
    // No name is no `name` key, rather than an empty one to be rendered.
    expect(toBindingAddress({ email: "a@example.test" })).toEqual({ email: "a@example.test" });
  });

  it("passes a name with parentheses through untouched", () => {
    // Staging's sender name. Folded into `Name <address>` unquoted, the
    // parentheses read as an address comment and the first real send failed
    // with "Invalid email address: Invalid email user".
    const built = buildBindingMessage({
      ...MESSAGE,
      from: { email: "verde-bot@example.test", name: "Los Verdes (verde-bot staging)" },
    });

    expect(built.from).toEqual({
      email: "verde-bot@example.test",
      name: "Los Verdes (verde-bot staging)",
    });
    expect(built.to).toEqual({ email: "member@example.com", name: "Jane Doe" });
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

  it("leaves attachments out entirely when there are none", () => {
    // Rather than an empty list, which is a claim that there are attachments
    // and they are nothing.
    expect(buildBindingMessage(MESSAGE)).not.toHaveProperty("attachments", []);
    expect(buildBindingMessage(MESSAGE).attachments).toBeUndefined();
  });
});
