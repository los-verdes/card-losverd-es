import { afterEach, describe, expect, it, vi } from "vitest";
import { SENDGRID_SEND_URL, sendEmail, type EmailMessage } from "../../src/email/sendgrid";

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

    await sendEmail("SG.test-key", {
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

    await sendEmail("SG.test-key", MESSAGE);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("asm");
  });

  it("throws with SendGrid's status and error body on failure", async () => {
    mockSendGrid(400, '{"errors":[{"message":"bad"}]}');
    await expect(sendEmail("SG.test-key", MESSAGE)).rejects.toThrow(
      'SendGrid mail send failed: HTTP 400 {"errors":[{"message":"bad"}]}',
    );
  });

  it.each([undefined, ""])("fails closed without calling SendGrid when the API key is %j", async (apiKey) => {
    const fetchSpy = mockSendGrid(202);
    await expect(sendEmail(apiKey, MESSAGE)).rejects.toThrow("SENDGRID_API_KEY is not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
