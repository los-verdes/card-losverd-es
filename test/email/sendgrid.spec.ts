import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_ANY_RECIPIENT,
  SENDGRID_SEND_URL,
  allowsRecipient,
  parseRecipientAllowlist,
  sendEmail,
  type EmailMessage,
} from "../../src/email/sendgrid";

afterEach(() => {
  vi.restoreAllMocks();
});

/** An environment permitted to email anyone, as production is. */
const ANY_RECIPIENT = { SENDGRID_API_KEY: "SG.test-key", EMAIL_RECIPIENT_ALLOWLIST: "*" };

const MESSAGE: EmailMessage = {
  from: { email: "verde-bot@losverd.es", name: "Los Verdes (verde-bot)" },
  to: { email: "jane@example.com", name: "Jane Doe" },
  subject: "Subject",
  text: "plain",
  html: "<p>html</p>",
};

function mockSendGrid(status: number, body?: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body ?? null, { status }));
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

describe("sendEmail", () => {
  it("POSTs a Mail Send request with bearer auth, text before HTML, attachments, and ASM group", async () => {
    const fetchSpy = mockSendGrid(202);
    // Bigger than the base64 encoder's chunk size, with every byte value.
    const big = Uint8Array.from({ length: 20_000 }, (_, i) => i % 256);

    await sendEmail(ANY_RECIPIENT, {
      ...MESSAGE,
      attachments: [{ filename: "card.png", type: "image/png", content: big }],
      unsubscribeGroupId: 29631,
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SENDGRID_SEND_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer SG.test-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: { email: "verde-bot@losverd.es", name: "Los Verdes (verde-bot)" },
      personalizations: [{ to: [{ email: "jane@example.com", name: "Jane Doe" }] }],
      subject: "Subject",
      content: [
        { type: "text/plain", value: "plain" },
        { type: "text/html", value: "<p>html</p>" },
      ],
      asm: { group_id: 29631 },
    });
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ filename: "card.png", type: "image/png", disposition: "attachment" });
    expect(base64ToBytes(body.attachments[0].content)).toEqual(big);
  });

  it("omits attachments and ASM when not given", async () => {
    const fetchSpy = mockSendGrid(202);

    await sendEmail(ANY_RECIPIENT, MESSAGE);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("asm");
  });

  it("throws with SendGrid's status and error body on failure", async () => {
    mockSendGrid(400, '{"errors":[{"message":"bad"}]}');
    await expect(sendEmail(ANY_RECIPIENT, MESSAGE)).rejects.toThrow(
      'SendGrid mail send failed: HTTP 400 {"errors":[{"message":"bad"}]}',
    );
  });

  it.each([undefined, ""])("fails closed without calling SendGrid when the API key is %j", async (apiKey) => {
    const fetchSpy = mockSendGrid(202);
    await expect(
      sendEmail({ SENDGRID_API_KEY: apiKey, EMAIL_RECIPIENT_ALLOWLIST: "*" }, MESSAGE),
    ).rejects.toThrow("SENDGRID_API_KEY is not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
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
  it("does not call SendGrid for a recipient this environment may not email", async () => {
    const fetchSpy = mockSendGrid(202);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail(
      { SENDGRID_API_KEY: "SG.test-key", EMAIL_RECIPIENT_ALLOWLIST: "losverd.es" },
      MESSAGE,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("always says so in the log, and never writes the address down", async () => {
    // The case this is for: someone testing delivery from staging long after
    // this was added, finding nothing arrives, and having no idea why. The
    // address itself is withheld because a suppressed recipient is exactly
    // the one that might be a real member's.
    mockSendGrid(202);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail(
      { SENDGRID_API_KEY: "SG.test-key", EMAIL_RECIPIENT_ALLOWLIST: "losverd.es" },
      MESSAGE,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Email suppressed"),
      expect.objectContaining({ recipientDomain: "example.com", allowlist: "losverd.es" }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("jane@example.com");
  });

  it("says plainly when the list is empty, rather than looking unconfigured", async () => {
    mockSendGrid(202);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ SENDGRID_API_KEY: "SG.test-key", EMAIL_RECIPIENT_ALLOWLIST: "" }, MESSAGE);

    expect(warnSpy.mock.calls[0][1]).toMatchObject({ allowlist: "(empty -- nobody)" });
  });

  it("suppresses rather than throwing, since it is a setting and not a failure", async () => {
    // It runs inside `waitUntil` and inside the queue consumer. Throwing
    // would dead-letter a message, or fail a member-visible request, for
    // something working exactly as configured.
    mockSendGrid(202);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      sendEmail({ SENDGRID_API_KEY: undefined, EMAIL_RECIPIENT_ALLOWLIST: "" }, MESSAGE),
    ).resolves.toBeUndefined();
  });
});
