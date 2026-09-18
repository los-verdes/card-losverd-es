import { createExecutionContext, env } from "cloudflare:test";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { MEMBERSHIP_STORE_URL, loadCurrentMember, type PortalEnv } from "../../src/member/portal";
import { getTestCertChain } from "../fixtures/certChain";
import LOGO from "../fixtures/sample-logo.png";

const SESSION_KEY = "test-session-signing-key-0123456789";
const USER_ID = 7;
const MEMBER_PATHS = ["/", "/card.png", "/passes/apple.pkpass", "/passes/google"];

beforeEach(() => {
  const chain = getTestCertChain();
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  env.PASS_SIGNATURE_KEY = "test-pass-signature-key".repeat(5);
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASSKIT_PASS_TYPE_IDENTIFIER = "pass.es.losverd.card";
  env.PASSKIT_TEAM_IDENTIFIER = "TEAMID1234";
  env.PASSKIT_ORGANIZATION_NAME = "Los Verdes";
  env.PASSKIT_WEB_SERVICE_URL = "https://card.losverd.es/passkit";
  env.APPLE_PASS_CERT_PEM = chain.leafCertPem;
  env.APPLE_PASS_KEY_PEM = chain.leafPrivateKeyPem;
  env.APPLE_WWDR_CERT_PEM = chain.rootCertPem;
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM members");
  await env.DB.exec("DELETE FROM users");
  const { objects } = await env.ASSETS.list();
  for (const { key } of objects) {
    await env.ASSETS.delete(key);
  }
});

async function get(path: string, loggedInAs: number | null = USER_ID) {
  const headers = new Headers();
  if (loggedInAs !== null) {
    const token = await issueSessionToken(SESSION_KEY, { userId: loggedInAs, isAdmin: false });
    headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return worker.fetch(
    new Request(`https://card.losverd.es${path}`, { headers, redirect: "manual" }),
    env,
    createExecutionContext(),
  );
}

async function insertUser(email = "jane@example.com", id = USER_ID) {
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind(id, email).run();
}

async function insertMember(fields: {
  memberId?: string;
  email?: string;
  userId?: number | null;
  firstName?: string;
  lastName?: string;
  tier?: string;
  expirationDate?: string;
  memberSince?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, membership_tier, status, expiration_date, member_since, user_id, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 'token', 1)`,
  )
    .bind(
      fields.memberId ?? "BC-1",
      fields.firstName ?? "Jane",
      fields.lastName ?? "Doe",
      fields.email ?? "jane@example.com",
      fields.tier ?? "los-pringles",
      fields.expirationDate ?? "2099-03-04",
      fields.memberSince === undefined ? "2021-07-15" : fields.memberSince,
      fields.userId ?? null,
    )
    .run();
}

async function seedCurrentMember() {
  await insertUser();
  await insertMember({});
}

async function seedTemplateAssets() {
  for (const name of ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"]) {
    await env.ASSETS.put(`templates/apple/${name}`, new Uint8Array(LOGO));
  }
  // The card image's crest is moving to its own R2 key (PR #44); seed both
  // so the /card.png test passes before and after that change.
  await env.ASSETS.put("templates/card/crest.png", new Uint8Array(LOGO));
}

describe("access control", () => {
  it.each([...MEMBER_PATHS, "/no-active-membership"])("%s redirects logged-out visitors to login", async (path) => {
    const res = await get(path, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it.each(MEMBER_PATHS)("%s redirects a user without a current membership", async (path) => {
    await insertUser();
    await insertMember({ expirationDate: "2020-01-01" });

    const res = await get(path);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/no-active-membership");
  });

  it("loadCurrentMember redirects if the membership disappeared after requireActiveMembership ran", async () => {
    const app = new Hono<PortalEnv>();
    app.get(
      "/",
      async (c, next) => {
        c.set("session", { userId: 404, isAdmin: false, issuedAt: 0, expiresAt: 0 });
        await next();
      },
      loadCurrentMember,
      (c) => c.text("unreachable"),
    );

    const res = await app.request("/", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/no-active-membership");
  });
});

describe("GET /", () => {
  it("shows the member's card, wallet links, and a logout button", async () => {
    await seedCurrentMember();

    const res = await get("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("Jane Doe");
    expect(html).toContain("los-pringles");
    expect(html).toContain("Member since Jul 2021");
    expect(html).toContain("Good through Mar 4, 2099");
    expect(html).toContain('<img src="/card.png"');
    expect(html).toMatch(/<a href="\/passes\/apple.pkpass"[^>]*>Add to Apple Wallet<\/a>/);
    expect(html).toMatch(/<a href="\/passes\/google"[^>]*>Add to Google Wallet<\/a>/);
    expect(html).toMatch(/<a href="\/email-card"[^>]*>Email me my card<\/a>/);
    expect(html).toMatch(/<form method="post" action="\/logout"/);
  });

  it("omits Member since when it isn't known", async () => {
    await insertUser();
    await insertMember({ memberSince: null });

    const html = await (await get("/")).text();

    expect(html).toContain("Good through");
    expect(html).not.toContain("Member since");
  });

  it("finds a membership linked by user_id when the email-matched one has lapsed", async () => {
    await insertUser("jane@example.com");
    await insertMember({ memberId: "BC-OLD", email: "jane@example.com", expirationDate: "2020-01-01" });
    await insertMember({
      memberId: "BC-NEW",
      email: "jane.work@example.com",
      userId: USER_ID,
      firstName: "Janet",
      lastName: "Linked",
    });

    const html = await (await get("/")).text();

    expect(html).toContain("Janet Linked");
    expect(html).not.toContain("Jane Doe");
  });

  it("escapes member names", async () => {
    await insertUser();
    await insertMember({ firstName: "<script>alert(1)</script>", lastName: "O'Brien & Co" });

    const html = await (await get("/")).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; Co");
  });
});

describe("GET /card.png", () => {
  it("renders the member's card image, uncached", async () => {
    await seedCurrentMember();
    await seedTemplateAssets();

    const res = await get("/card.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const png = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("GET /passes/apple.pkpass", () => {
  it("downloads the member's signed Apple Wallet pass", async () => {
    await seedCurrentMember();
    await seedTemplateAssets();

    const res = await get("/passes/apple.pkpass");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.apple.pkpass");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="los-verdes-membership.pkpass"');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["pass.json", "manifest.json", "signature"]));
    const pass = JSON.parse(new TextDecoder().decode(files["pass.json"])) as { serialNumber: string };
    expect(pass.serialNumber).toBe("BC-1");
  });
});

describe("GET /passes/google", () => {
  it("redirects to the member's Save to Google Wallet link", async () => {
    await seedCurrentMember();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);

    const res = await get("/passes/google");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("shows a friendly 503 page when Google Wallet isn't configured", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedCurrentMember();

    const res = await get("/passes/google");

    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("Google Wallet is unavailable");
    expect(html).toContain('<a href="/"');
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("GET /no-active-membership", () => {
  it("names the signed-in email, links to the store, and offers logout", async () => {
    await insertUser("<b>jane</b>@example.com");

    const res = await get("/no-active-membership");

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No current membership was found for <strong>&lt;b&gt;jane&lt;/b&gt;@example.com</strong>");
    expect(html).toContain(`href="${MEMBERSHIP_STORE_URL}"`);
    expect(MEMBERSHIP_STORE_URL).toBe("https://store.losverdesatx.org/membership/");
    expect(html).toMatch(/<form method="post" action="\/logout"/);
  });

  it("sends a session whose user no longer exists back to login", async () => {
    const res = await get("/no-active-membership", 404);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });
});
