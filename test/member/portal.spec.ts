import "../setup/d1";
import { STYLESHEET_PATH } from "../../src/styles";
import { createExecutionContext, env } from "cloudflare:test";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import worker from "../../src/index";
import { MEMBERSHIP_STORE_URL, loadCurrentMember, type PortalEnv } from "../../src/member/portal";
import { getTestCertChain } from "../fixtures/certChain";
import { CARD_WIDTH, CARD_HEIGHT } from "../../src/cardimage/template";
import LOGO from "../fixtures/sample-logo.png";
import { fakeGoogleWallet } from "../google/fake";

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
  await env.DB.exec("DELETE FROM membership_orders");
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
  expirationDate?: string;
  memberSince?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO members (member_id, first_name, last_name, email, status, expiration_date, member_since, user_id, auth_token, last_updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 'token', 1)`,
  )
    .bind(
      fields.memberId ?? "BC-1",
      fields.firstName ?? "Jane",
      fields.lastName ?? "Doe",
      fields.email ?? "jane@example.com",
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

async function insertOrder(fields: {
  orderId: string;
  memberEmail?: string;
  productName?: string | null;
  status?: string | null;
  createdOn?: string;
  expiresOn?: string;
  source?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO membership_orders (order_id, source, order_email, member_email, product_name, status,
                                    created_on, expires_on, first_seen_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sync')`,
  )
    .bind(
      fields.orderId,
      fields.source ?? "bigcommerce",
      fields.memberEmail ?? "jane@example.com",
      fields.memberEmail ?? "jane@example.com",
      fields.productName === undefined ? "Los Verdes Membership" : fields.productName,
      fields.status === undefined ? "Completed" : fields.status,
      fields.createdOn ?? "2024-03-04",
      fields.expiresOn ?? "2025-03-04",
    )
    .run();
}

describe("access control", () => {
  it.each([...MEMBER_PATHS, "/no-active-membership"])("%s redirects logged-out visitors to login", async (path) => {
    const res = await get(path, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login(\?|$)/);
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

describe("the card image", () => {
  it("reserves its space before it arrives, so nothing jumps", async () => {
    // The image is rendered on demand, so it is never instant. Without
    // intrinsic dimensions the browser cannot know its shape until the bytes
    // land, and everything below it moves when they do.
    await seedCurrentMember();
    await seedTemplateAssets();

    const html = await (await get("/")).text();

    expect(html).toContain('width="1050"');
    expect(html).toContain('height="660"');
    expect(html).toContain('class="card-image"');
  });

  it("carries its own sizing, so a stale stylesheet cannot overflow a phone", async () => {
    // /assets/app.css is cached for an hour and this page is not, so after a
    // deploy a browser can hold new HTML and old CSS. Sizing that lived only
    // in the stylesheet failed open at the card's intrinsic 1050px and ran
    // off the side of a phone screen -- worse than the layout shift it was
    // added to fix. Inline, the two cannot disagree.
    await seedCurrentMember();
    await seedTemplateAssets();

    const html = await (await get("/")).text();
    const img = html.match(/<img[^>]*class="card-image"[^>]*>/)?.[0] ?? "";

    expect(img).toContain("width: 100%");
    expect(img).toContain("height: auto");
  });

  it("takes its dimensions from the renderer rather than repeating them", async () => {
    // A second copy of the card's size would be wrong the first time the
    // card is resized, and wrong silently -- the page would simply reserve
    // the wrong shape.
    await seedCurrentMember();
    await seedTemplateAssets();

    const html = await (await get("/")).text();

    expect(html).toContain(`width="${CARD_WIDTH}"`);
    expect(html).toContain(`height="${CARD_HEIGHT}"`);
  });
});

describe("the admin nav on a member page", () => {
  const ADMIN_NAV = /<nav class="admin-nav">/;

  async function makeAdmin(id = USER_ID) {
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(id).run();
  }

  it("is absent for an ordinary member", async () => {
    await seedCurrentMember();

    expect(await (await get("/")).text()).not.toMatch(ADMIN_NAV);
  });

  it("appears on the card page for an admin, with everything it links", async () => {
    // The whole point of the change: one quiet line at the foot of the page
    // named one destination out of thirteen and was easy to miss entirely.
    await seedCurrentMember();
    await makeAdmin();

    const html = await (await get("/")).text();

    expect(html).toMatch(ADMIN_NAV);
    expect(html).toContain('href="/admin/members"');
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain('href="/admin/preflight"');
  });

  it("does not offer to take an admin to the page they are on", async () => {
    await seedCurrentMember();
    await makeAdmin();

    const html = await (await get("/")).text();

    expect(html).toContain('<span class="nav-here" aria-current="page">My card</span>');
    expect(html).not.toContain('<a href="/">My card</a>');
  });

  it("renders outside the card's column, so the card is unchanged for everyone", async () => {
    // The nav is wider than the 28rem member column. Putting it inside would
    // have meant widening the card page for every member to suit admins.
    await seedCurrentMember();
    await makeAdmin();

    const html = await (await get("/")).text();

    expect(html.indexOf('class="admin-nav"')).toBeLessThan(html.indexOf("<main>"));
  });

  it("follows the database rather than the session cookie", async () => {
    // Every cookie this helper issues claims isAdmin: false, which is exactly
    // the state of a session predating the promotion -- and those renew at
    // most every thirty days. Reading `users` is what stops a newly granted
    // admin waiting a month for a way in.
    await seedCurrentMember();
    expect(await (await get("/")).text()).not.toMatch(ADMIN_NAV);

    await makeAdmin();

    expect(await (await get("/")).text()).toMatch(ADMIN_NAV);
  });

  it("is offered to an admin who has no membership at all", async () => {
    // Someone on the board who never bought a membership never reaches the
    // card page, so this is the only place they would find the admin pages.
    await insertUser();
    await makeAdmin();

    const html = await (await get("/no-active-membership")).text();

    expect(html).toMatch(ADMIN_NAV);
  });

  it("is absent on the no-membership page for an ordinary user", async () => {
    await insertUser();

    expect(await (await get("/no-active-membership")).text()).not.toMatch(ADMIN_NAV);
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
    expect(html).toContain("Member since Jul 2021");
    expect(html).toContain("Good through Mar 4, 2099");
    // Attribute order is the renderer's business; that the card is on the
    // page is this test's.
    expect(html).toMatch(/<img[^>]*src="\/card\.png"/);
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

describe("GET / membership history", () => {
  it("lists the member's orders, newest first, with what a receipt would show", async () => {
    await seedCurrentMember();
    await insertOrder({ orderId: "104", createdOn: "2023-04-04", expiresOn: "2024-04-03" });
    await insertOrder({
      orderId: "106",
      createdOn: "2026-09-18",
      expiresOn: "2027-09-18",
      productName: "Los Verdes Membership 2026",
    });

    const body = await (await get("/")).text();

    expect(body).toContain("Membership history");
    expect(body).toContain("Order #106");
    expect(body).toContain("Los Verdes Membership 2026");
    expect(body).toContain("Order #104");
    // Newest first, and no internal id convention reaches the member.
    expect(body.indexOf("Order #106")).toBeLessThan(body.indexOf("Order #104"));
    expect(body).not.toContain("_bc");
  });

  it("says when an order doesn't count, which is what explains a lapsed card", async () => {
    await seedCurrentMember();
    await insertOrder({ orderId: "105", status: "Refunded" });

    const body = await (await get("/")).text();

    expect(body).toContain("Order #105");
    expect(body).toContain("count towards membership");
  });

  it("marks nothing when every order counts", async () => {
    await seedCurrentMember();
    await insertOrder({ orderId: "104" });

    const body = await (await get("/")).text();

    expect(body).not.toContain("count towards membership");
  });

  it("shows a gifted order on the recipient's history, not the purchaser's", async () => {
    await seedCurrentMember();
    // Attribution moves member_email only; the order was paid for by someone else.
    await env.DB.prepare(
      `INSERT INTO membership_orders (order_id, source, order_email, member_email, product_name, status,
                                      created_on, expires_on, first_seen_via)
       VALUES ('200', 'bigcommerce', 'buyer@example.com', 'jane@example.com', 'Gift Membership', 'Completed',
               '2026-01-05', '2027-01-05', 'sync')`,
    ).run();
    await insertOrder({ orderId: "201", memberEmail: "buyer@example.com" });

    const body = await (await get("/")).text();

    expect(body).toContain("Order #200");
    expect(body).toContain("Gift Membership");
    expect(body).not.toContain("Order #201");
  });

  it("copes with a Squarespace-era order that has no product name or status", async () => {
    // Many imported rows have neither, and a blank status still counts for
    // that era (src/lib/membershipOrders.ts).
    await seedCurrentMember();
    await insertOrder({
      orderId: "0cd5ad745fbc40fd95697470",
      source: "squarespace",
      productName: null,
      status: null,
      createdOn: "2019-06-01",
      expiresOn: "2020-05-31",
    });

    const body = await (await get("/")).text();

    expect(body).toContain("Order #0cd5ad745fbc40fd95697470");
    expect(body).toContain("Jun 1, 2019");
    expect(body).not.toContain("count towards membership");
    expect(body).not.toContain("null");
  });

  it("tells a member with no orders on record, naming the address it looked under", async () => {
    await seedCurrentMember();

    const body = await (await get("/")).text();

    expect(body).toContain("No membership orders are on record for");
    expect(body).toContain("jane@example.com");
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return fakeGoogleWallet(url);
    });

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

  it("shows the orders on record when there are any, and says why they don't count", async () => {
    // The page used to tell a lapsed member to check the address they signed
    // in with -- advice that is wrong whenever their orders are right here,
    // and that sends them to the merch team to be told what the page could
    // have said itself.
    await insertUser("lapsed@example.com");
    await insertOrder({
      orderId: "1001",
      memberEmail: "lapsed@example.com",
      productName: "Los Verdes Membership",
      status: "Refunded",
      createdOn: "2023-04-01",
      expiresOn: "2024-04-01",
    });

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("Membership history");
    expect(html).toContain("Order #1001");
    // Escaped in the rendered HTML, so match the part that is not.
    expect(html).toContain("count towards membership");
    expect(html).toContain("We do have an order on record under that address");
    expect(html).not.toContain("Check that the email address you signed in with");
  });

  it("counts the orders it found rather than saying 'some'", async () => {
    await insertUser("lapsed@example.com");
    for (const orderId of ["1001", "1002"]) {
      await insertOrder({ orderId, memberEmail: "lapsed@example.com", status: "Completed" });
    }

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("We do have 2 orders on record under that address");
    expect(html).toContain("none of them is current");
  });

  it("offers a renewal rather than a first purchase once there are orders", async () => {
    await insertUser("lapsed@example.com");
    await insertOrder({ orderId: "1001", memberEmail: "lapsed@example.com" });

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("Ready to renew?");
    expect(html).not.toContain("Not a member yet");
  });

  it("shows no history at all when there are no orders", async () => {
    // "No current membership was found" followed by "no orders are on record"
    // is the same sentence twice, and it crowds out the advice that is
    // actually useful in that case.
    await insertUser("nobody@example.com");

    const html = await (await get("/no-active-membership")).text();

    expect(html).not.toContain("Membership history");
    expect(html).toContain("Check that the email address you signed in with");
  });

  it("leaves the Apple relay explanation alone, since a relay never has orders", async () => {
    await insertUser("abc123@privaterelay.appleid.com");

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("Hide My Email");
    expect(html).not.toContain("Membership history");
  });

  it("sends a session whose user no longer exists back to login", async () => {
    const res = await get("/no-active-membership", 404);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login(\?|$)/);
  });
});

describe("branding", () => {
  it("links the stylesheet and drops the inline body style", async () => {
    await seedCurrentMember();

    const html = await (await get("/")).text();

    expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET_PATH}"`);
    expect(html).toContain('<body class="member">');
  });
});

describe("the no-membership page", () => {
  it("tells an ordinary user to check the address they signed in with", async () => {
    await insertUser("someone@example.com");

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("matches the one used to");
    expect(html).not.toContain("Hide My Email");
  });

  it("names Apple's private relay when that is what the address is", async () => {
    // Apple offers "Hide My Email" on every sign-in, and choosing it lands a
    // paying member here with no way to work out why. Naming the cause is
    // half the remedy; the claim link below is the other half.
    await insertUser("abc123def@privaterelay.appleid.com");

    const html = await (await get("/no-active-membership")).text();

    expect(html).toContain("Hide My Email");
    expect(html).not.toContain("matches the one used to");
  });

  it("no longer sends a relay member back to sign in again", async () => {
    // The old advice was to sign out and choose Share My Email instead.
    // Apple's own guidance is to accept the relay address, and that toggle
    // turns out to be hard to find even for a technical member, so the page
    // now offers to confirm the membership address by email instead (#144).
    await insertUser("abc123def@privaterelay.appleid.com");

    const html = await (await get("/no-active-membership")).text();

    expect(html).not.toContain("Share My Email");
    expect(html).toContain('href="/claim-membership"');
  });

  it("recognises the relay domain whatever its case", async () => {
    await insertUser("ABC123@PrivateRelay.AppleID.com");

    expect(await (await get("/no-active-membership")).text()).toContain("Hide My Email");
  });

  it("recognises the private.icloud.com domain Apple is moving new sign-ins to", async () => {
    // Apple began issuing Sign in with Apple addresses on private.icloud.com
    // during 2026, keeping the older domain working. Matching only the old
    // one would send every new Apple member the generic advice to check the
    // address on their order, which for a relay address is a dead end.
    await insertUser("abc123def@private.icloud.com");

    expect(await (await get("/no-active-membership")).text()).toContain("Hide My Email");
  });
});
