import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENDGRID_SEND_URL } from "../../src/email/sendgrid";
import { TURNSTILE_SITEVERIFY_URL } from "../../src/email/turnstile";
import worker from "../../src/index";
import { IP_RATE_LIMIT, RECIPIENT_RATE_LIMIT } from "../../src/member/email-card";
import { getTestCertChain } from "../fixtures/certChain";
import LOGO from "../fixtures/sample-logo.png";
import { fakeGoogleWallet } from "../google/fake";

const ORIGIN = "https://card.losverd.es";
const GOOGLE_SAVE_PREFIX = "https://pay.google.com/gp/v/save/";

beforeEach(async () => {
  const chain = getTestCertChain();
  env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
  env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
  env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
  env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
  env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
  env.PUBLIC_BASE_URL = ORIGIN;
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  env.TURNSTILE_SITE_KEY = "0x4AAAAAAA-test-site-key";
  env.TURNSTILE_SECRET_KEY = "0x4AAAAAAA-test-secret";
  env.SENDGRID_API_KEY = "SG.test-key";
  env.SENDGRID_UNSUBSCRIBE_GROUP_ID = "29631";
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
  // `templates/card/crest.png` too, so these keep passing once the card image
  // reads its crest from there instead of the Apple pass template.
  for (const key of [
    "templates/apple/icon.png",
    "templates/apple/icon@2x.png",
    "templates/apple/logo.png",
    "templates/apple/logo@2x.png",
    "templates/card/crest.png",
  ]) {
    await env.ASSETS.put(key, new Uint8Array(LOGO));
  }

  await insertMember("BC-1", "jane@example.com", "2099-03-04");
  await insertMember("BC-2", "lapsed@example.com", "2020-01-01");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM rate_limit_counters");
  const listed = await env.ASSETS.list();
  await env.ASSETS.delete(listed.objects.map((o) => o.key));
});

async function insertMember(memberId: string, email: string, expirationDate: string) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, auth_token, last_updated_at)
     VALUES (?, 'Jane', 'Doe', ?, 'standard', 'active', ?, '2021-07-15', 'token', 1)`,
  )
    .bind(memberId, email, expirationDate)
    .run();
}

interface MockOptions {
  turnstileSuccess?: boolean;
  sendGridStatus?: number;
}

/** Fakes Turnstile Siteverify and SendGrid; any other outbound fetch fails the test. */
function mockUpstreams({ turnstileSuccess = true, sendGridStatus = 202 }: MockOptions = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TURNSTILE_SITEVERIFY_URL) {
      return Response.json({ success: turnstileSuccess, "error-codes": [] });
    }
    if (url === SENDGRID_SEND_URL) {
      return new Response(sendGridStatus === 202 ? null : "SendGrid is down", { status: sendGridStatus });
    }
    return fakeGoogleWallet(url);
  });
}

function callsTo(fetchSpy: ReturnType<typeof mockUpstreams>, url: string) {
  return fetchSpy.mock.calls.filter(([input]) => String(input) === url);
}

function sentMessages(fetchSpy: ReturnType<typeof mockUpstreams>) {
  return callsTo(fetchSpy, SENDGRID_SEND_URL).map(([, init]) => JSON.parse(init!.body as string));
}

async function request(init: RequestInit & { path?: string } = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${init.path ?? "/email-card"}`, init), env, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, headers: res.headers };
}

function submit(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return request({
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const submitEmail = (email: string) => submit({ email, "cf-turnstile-response": "token-123" });

describe("GET /email-card", () => {
  it("shows the form with the Turnstile widget", async () => {
    const { status, body } = await request();

    expect(status).toBe(200);
    expect(body).toContain('<form method="post" action="/email-card">');
    expect(body).toContain('name="email"');
    expect(body).toContain('<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-test-site-key"></div>');
    expect(body).toContain('src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    expect(body).not.toContain('role="alert"');
    // Somewhere to go other than back into the form, on the page a visitor
    // is most likely to arrive at without a session.
    expect(body).toContain('<a href="/">Back to the start</a>');
  });

  it.each(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "SENDGRID_API_KEY"] as const)(
    "shows a temporarily-unavailable page instead of the form without %s",
    async (key) => {
      env[key] = undefined;

      const { status, body } = await request();

      expect(status).toBe(503);
      expect(body).toContain("Temporarily unavailable");
      expect(body).not.toContain("cf-turnstile");
    },
  );
});

describe("POST /email-card", () => {
  describe("doesn't reveal whether an address belongs to a member", () => {
    it("gives a current member, a lapsed member, and a non-member the identical response", async () => {
      const fetchSpy = mockUpstreams();

      const member = await submitEmail("jane@example.com");
      const lapsed = await submitEmail("lapsed@example.com");
      const stranger = await submitEmail("nobody@example.com");

      expect(member.status).toBe(200);
      expect(member.body).toContain("Check your email");
      expect(lapsed).toEqual(member);
      expect(stranger).toEqual(member);
      // Every submission passed the bot check, but only the current member was emailed.
      expect(callsTo(fetchSpy, TURNSTILE_SITEVERIFY_URL)).toHaveLength(3);
      const sent = sentMessages(fetchSpy);
      expect(sent).toHaveLength(1);
      expect(sent[0].personalizations[0].to[0].email).toBe("jane@example.com");
    });

    it("treats a revoked member as a non-member", async () => {
      await env.DB.exec("UPDATE members SET status = 'revoked' WHERE member_id = 'BC-1'");
      const fetchSpy = mockUpstreams();

      expect((await submitEmail("jane@example.com")).body).toContain("Check your email");
      expect(sentMessages(fetchSpy)).toHaveLength(0);
    });

    it("offers a way onward, and sends nobody to a losverd.es address", async () => {
      mockUpstreams();

      const { body } = await submitEmail("jane@example.com");

      expect(body).toContain('href="/"');
      expect(body).toContain("merchteam@losverdesatx.org");
      // Visitors are not directed to write to anything on this domain
      // (decided 2026-09-17); it remains the sending identity only.
      expect(body).not.toMatch(/mailto:[^"]*losverd\.es/);
    });
  });

  describe("email contents", () => {
    it("points a wrong recipient at the merch team, not a losverd.es address", async () => {
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      const [text, html] = sentMessages(fetchSpy)[0].content as { value: string }[];
      for (const { value } of [text, html]) {
        expect(value).toContain("merchteam@losverdesatx.org");
        expect(value).not.toContain("support@losverd.es");
      }
    });

    it("sends the card image and Apple pass as attachments, without a Google link when unconfigured", async () => {
      const fetchSpy = mockUpstreams();

      await submitEmail("  Jane@Example.COM ");

      const [call] = callsTo(fetchSpy, SENDGRID_SEND_URL);
      expect((call[1]!.headers as Record<string, string>).authorization).toBe("Bearer SG.test-key");
      const [message] = sentMessages(fetchSpy);
      expect(message.from).toEqual({ email: "verde-bot@losverd.es", name: "Los Verdes (verde-bot)" });
      expect(message.personalizations).toEqual([{ to: [{ email: "jane@example.com", name: "Jane Doe" }] }]);
      expect(message.subject).toBe("Los Verdes Membership Card Details");
      expect(message.asm).toEqual({ group_id: 29631 });

      const attachments = message.attachments as { filename: string; type: string; content: string; disposition: string }[];
      expect(attachments.map(({ filename, type, disposition }) => ({ filename, type, disposition }))).toEqual([
        { filename: "los-verdes-membership-card.png", type: "image/png", disposition: "attachment" },
        { filename: "los-verdes-membership-card.pkpass", type: "application/vnd.apple.pkpass", disposition: "attachment" },
      ]);
      const decode = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      expect(Array.from(decode(attachments[0].content).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const pass = JSON.parse(strFromU8(unzipSync(decode(attachments[1].content))["pass.json"]));
      expect(pass.serialNumber).toBe("BC-1");

      const [text, html] = message.content as { type: string; value: string }[];
      expect(text.type).toBe("text/plain");
      expect(html.type).toBe("text/html");
      for (const part of [text.value, html.value]) {
        expect(part).toContain("Jane Doe");
        expect(part).toContain("Good through Mar 4, 2099");
        expect(part).toContain("BC-1");
        expect(part).not.toContain("Google Wallet");
      }
    });

    it("includes a Save to Google Wallet link when Google Wallet is configured", async () => {
      const { privateKey } = await generateKeyPair("RS256", { extractable: true });
      env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
      env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      const [message] = sentMessages(fetchSpy);
      const [text, html] = message.content as { value: string }[];
      expect(text.value).toContain(`- Google Wallet: ${GOOGLE_SAVE_PREFIX}`);
      expect(html.value).toContain(`<a href="${GOOGLE_SAVE_PREFIX}`);
    });

    it("sends without the Google link (and logs) if building it fails", async () => {
      env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
      env.GOOGLE_WALLET_PRIVATE_KEY_PEM = "not a pem";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      const [message] = sentMessages(fetchSpy);
      expect(message.content[1].value).not.toContain("Google Wallet");
      expect(errorSpy).toHaveBeenCalledWith(
        "Email card: Google Wallet link failed; sending without it",
        expect.objectContaining({ memberId: "BC-1" }),
      );
    });

    it("sends without an ASM group when none is configured", async () => {
      env.SENDGRID_UNSUBSCRIBE_GROUP_ID = "";
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      expect(sentMessages(fetchSpy)[0]).not.toHaveProperty("asm");
    });

    it("links back to PUBLIC_BASE_URL rather than a hardcoded production origin", async () => {
      env.PUBLIC_BASE_URL = "https://staging.example.test/";
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      const [text, html] = sentMessages(fetchSpy)[0].content as { value: string }[];
      expect(text.value).toContain("Visit online at: https://staging.example.test\n");
      expect(text.value).toContain("made at https://staging.example.test/email-card at:");
      expect(html.value).toContain('<a href="https://staging.example.test">staging.example.test</a>');
      expect(html.value).toContain("https://staging.example.test/email-card at:");
      for (const part of [text.value, html.value]) {
        expect(part).not.toContain("card.losverd.es");
      }
    });

    it("escapes member-provided text in the HTML body", async () => {
      await env.DB.exec("UPDATE members SET first_name = '<script>x</script>' WHERE member_id = 'BC-1'");
      const fetchSpy = mockUpstreams();

      await submitEmail("jane@example.com");

      const html = sentMessages(fetchSpy)[0].content[1].value as string;
      expect(html).not.toContain("<script>x</script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("bot check", () => {
    it("rejects a submission Turnstile doesn't verify, without sending anything", async () => {
      const fetchSpy = mockUpstreams({ turnstileSuccess: false });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { status, body } = await submit(
        { email: "jane@example.com", "cf-turnstile-response": "forged" },
        { "cf-connecting-ip": "203.0.113.7" },
      );

      expect(status).toBe(403);
      expect(body).toContain("verify that you&#39;re not a bot");
      expect(body).toContain('value="jane@example.com"');
      expect(body).not.toContain("Check your email");
      const [[, init]] = callsTo(fetchSpy, TURNSTILE_SITEVERIFY_URL);
      const verifyBody = init!.body as FormData;
      expect(verifyBody.get("secret")).toBe("0x4AAAAAAA-test-secret");
      expect(verifyBody.get("response")).toBe("forged");
      expect(verifyBody.get("remoteip")).toBe("203.0.113.7");
      expect(sentMessages(fetchSpy)).toHaveLength(0);
    });

    it("rejects a submission with no Turnstile token", async () => {
      const fetchSpy = mockUpstreams();

      const { status } = await submit({ email: "jane@example.com" });

      expect(status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"] as const)(
      "fails closed without %s",
      async (key) => {
        env[key] = undefined;
        const fetchSpy = mockUpstreams();

        const { status, body } = await submitEmail("jane@example.com");

        expect(status).toBe(503);
        expect(body).toContain("Temporarily unavailable");
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe("input", () => {
    it.each([
      ["malformed", { email: "not-an-email", "cf-turnstile-response": "token-123" }],
      ["missing a TLD", { email: "jane@example", "cf-turnstile-response": "token-123" }],
      ["overlong", { email: `${"a".repeat(250)}@example.com`, "cf-turnstile-response": "token-123" }],
      ["missing", { "cf-turnstile-response": "token-123" }],
    ])("rejects a %s email address before the bot check", async (_label, fields) => {
      const fetchSpy = mockUpstreams();

      const { status, body } = await submit(fields as Record<string, string>);

      expect(status).toBe(400);
      expect(body).toContain("Please enter a valid email address.");
      expect(body).toContain("cf-turnstile");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses a cross-site form post", async () => {
      const fetchSpy = mockUpstreams();

      const { status } = await submit(
        { email: "jane@example.com", "cf-turnstile-response": "token-123" },
        { Origin: "https://evil.example" },
      );

      expect(status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    it("logs a SendGrid failure without retrying, and still shows the same page", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = mockUpstreams({ sendGridStatus: 500 });

      const res = await submitEmail("jane@example.com");

      expect(res.status).toBe(200);
      expect(res.body).toContain("Check your email");
      expect(callsTo(failing, SENDGRID_SEND_URL)).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith("Email card delivery failed", {
        error: expect.stringContaining("HTTP 500 SendGrid is down"),
      });

      vi.restoreAllMocks();
      mockUpstreams();
      expect(await submitEmail("nobody@example.com")).toEqual(res);
    });

    it("logs a card rendering failure without emailing", async () => {
      await env.ASSETS.delete(["templates/apple/icon@2x.png", "templates/card/crest.png"]);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = mockUpstreams();

      expect((await submitEmail("jane@example.com")).status).toBe(200);

      expect(errorSpy).toHaveBeenCalledWith("Email card delivery failed", expect.anything());
      expect(sentMessages(fetchSpy)).toHaveLength(0);
    });

    it("fails closed without SENDGRID_API_KEY", async () => {
      env.SENDGRID_API_KEY = undefined;
      const fetchSpy = mockUpstreams();

      const { status, body } = await submitEmail("jane@example.com");

      expect(status).toBe(503);
      expect(body).toContain("Temporarily unavailable");
      expect(body).not.toContain("Check your email");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe("rate limiting", () => {
  it("returns 429 once a client IP exceeds its hourly limit, before calling Turnstile", async () => {
    const fetchSpy = mockUpstreams();
    const ip = { "cf-connecting-ip": "198.51.100.23" };
    for (let i = 0; i < IP_RATE_LIMIT.limit; i++) {
      expect((await submit({ email: `nobody${i}@example.com`, "cf-turnstile-response": "t" }, ip)).status).toBe(200);
    }
    const turnstileCallsBefore = callsTo(fetchSpy, TURNSTILE_SITEVERIFY_URL).length;

    const blocked = await submit({ email: "jane@example.com", "cf-turnstile-response": "t" }, ip);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain("Too many requests");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(callsTo(fetchSpy, TURNSTILE_SITEVERIFY_URL)).toHaveLength(turnstileCallsBefore);
    expect(sentMessages(fetchSpy)).toHaveLength(0);

    // A different client is unaffected.
    expect((await submit({ email: "jane@example.com", "cf-turnstile-response": "t" }, { "cf-connecting-ip": "198.51.100.99" })).status).toBe(200);
  });

  it("silently stops emailing an address after its daily limit, with an unchanged response", async () => {
    const fetchSpy = mockUpstreams();
    const responses = [];
    for (let i = 0; i < RECIPIENT_RATE_LIMIT.limit + 1; i++) {
      // Distinct IPs, so only the recipient limit is in play.
      responses.push(await submit({ email: "Jane@Example.com", "cf-turnstile-response": "t" }, { "cf-connecting-ip": `192.0.2.${i}` }));
    }

    expect(sentMessages(fetchSpy)).toHaveLength(RECIPIENT_RATE_LIMIT.limit);
    expect(new Set(responses.map((r) => `${r.status}:${r.body}`)).size).toBe(1);
  });

  it("counts non-member addresses the same way, so the limit can't reveal membership", async () => {
    mockUpstreams();
    for (let i = 0; i < RECIPIENT_RATE_LIMIT.limit + 1; i++) {
      await submit({ email: "stranger@example.com", "cf-turnstile-response": "t" }, { "cf-connecting-ip": `192.0.2.${i}` });
    }
    const counters = await env.DB.prepare(
      "SELECT count FROM rate_limit_counters WHERE key LIKE 'email-card:recipient:%'",
    ).all<{ count: number }>();
    expect(counters.results).toEqual([{ count: RECIPIENT_RATE_LIMIT.limit + 1 }]);
  });
});
