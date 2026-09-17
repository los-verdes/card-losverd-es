import { afterEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_SITEVERIFY_URL, verifyTurnstileToken } from "../../src/email/turnstile";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSiteverify(response: Response | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("verifyTurnstileToken", () => {
  it("POSTs the secret, token, and remote IP to Siteverify and accepts success", async () => {
    const fetchSpy = mockSiteverify(Response.json({ success: true, "error-codes": [] }));

    await expect(verifyTurnstileToken("secret-key", "token-123", "203.0.113.7")).resolves.toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("secret")).toBe("secret-key");
    expect(body.get("response")).toBe("token-123");
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  it("omits remoteip when it's unknown", async () => {
    const fetchSpy = mockSiteverify(Response.json({ success: true }));

    await expect(verifyTurnstileToken("secret-key", "token-123", null)).resolves.toBe(true);

    expect((fetchSpy.mock.calls[0][1]!.body as FormData).has("remoteip")).toBe(false);
  });

  it("rejects a token Siteverify doesn't accept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSiteverify(Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    await expect(verifyTurnstileToken("secret-key", "used-token")).resolves.toBe(false);
  });

  it.each<[string, Response | Error]>([
    ["an HTTP error", new Response("nope", { status: 500 })],
    ["a non-JSON body", new Response("<html>", { status: 200 })],
    ["a network error", new Error("connection reset")],
  ])("fails closed on %s", async (_label, response) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSiteverify(response);

    await expect(verifyTurnstileToken("secret-key", "token-123")).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith("Turnstile siteverify request failed", expect.anything());
  });

  it.each<[string, string | undefined, string | undefined]>([
    ["secret", undefined, "token-123"],
    ["token", "secret-key", undefined],
    ["token (empty)", "secret-key", ""],
  ])("fails closed without calling Siteverify when the %s is missing", async (_label, secret, token) => {
    const fetchSpy = mockSiteverify(Response.json({ success: true }));
    await expect(verifyTurnstileToken(secret, token)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
