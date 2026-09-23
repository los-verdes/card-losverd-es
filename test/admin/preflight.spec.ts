import "../setup/d1";
import { createExecutionContext, env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import forge from "node-forge";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CERT_EXPIRY_WARN_DAYS,
  MANUAL_STEPS,
  originVerdict,
  runPreflightChecks,
} from "../../src/admin/preflightChecks";
import { SESSION_COOKIE_NAME, issueSessionToken } from "../../src/auth/session";
import { signWebhookToken } from "../../src/bigcommerce/webhookToken";
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WALLET_API,
  resetGoogleWalletTokenCache,
} from "../../src/google/api";
import worker from "../../src/index";
import { fakeEmailBinding } from "../fixtures/emailBinding";

const SESSION_KEY = "test-session-signing-key-0123456789";
const ADMIN_ID = 1;
const MEMBER_ID = 2;
const PASS_TYPE = "pass.es.losverd.card";

const TEMPLATE_KEYS = [
  "templates/apple/icon.png",
  "templates/apple/icon@2x.png",
  "templates/apple/logo.png",
  "templates/apple/logo@2x.png",
  "templates/card/crest.png",
];

/**
 * A stand-in for an Apple-issued chain, built per case so a test can choose
 * the pass type in the subject's `uid` and the expiry date. `certChain.ts`
 * can't serve here: it memoizes one chain, and every interesting case in this
 * file is about a chain being subtly wrong.
 *
 * All of it is RSA, which is slow in pure JavaScript, so the expensive parts
 * are made once per file rather than once per test: the keys, the healthy
 * chain every test starts from, and the Google Wallet key. Each is a fixed
 * input no test changes, so building it again only ever produced the same
 * bytes. Before this the healthy chain was re-signed and a fresh 2048-bit key
 * generated for every one of this file's tests, which made it more than half
 * the time the whole suite spends in tests. A test that needs a chain that is
 * subtly wrong still builds one with `appleChain(options)`.
 */
let issuerKeys: forge.pki.rsa.KeyPair;
let leafKeys: forge.pki.rsa.KeyPair;
let otherKeys: forge.pki.rsa.KeyPair;
let healthyChain: ReturnType<typeof appleChain>;
let googleWalletKeyPem: string;

beforeAll(async () => {
  issuerKeys = forge.pki.rsa.generateKeyPair(2048);
  leafKeys = forge.pki.rsa.generateKeyPair(2048);
  otherKeys = forge.pki.rsa.generateKeyPair(2048);
  healthyChain = appleChain();
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  googleWalletKeyPem = await exportPKCS8(privateKey);
});

const ISSUER_CN = "Apple Worldwide Developer Relations Certification Authority (test stand-in)";

function certificate(options: {
  subject: forge.pki.CertificateField[];
  issuer: forge.pki.CertificateField[];
  publicKey: forge.pki.rsa.PublicKey;
  signWith: forge.pki.rsa.PrivateKey;
  notAfter: Date;
}): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = options.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  cert.validity.notAfter = options.notAfter;
  cert.setSubject(options.subject);
  cert.setIssuer(options.issuer);
  cert.sign(options.signWith, forge.md.sha256.create());
  return cert;
}

function appleChain(
  options: { passType?: string; notAfter?: Date; wwdrName?: string; mismatchedKey?: boolean } = {},
) {
  const issuerAttrs = [{ name: "commonName", value: ISSUER_CN }];
  const wwdr = certificate({
    subject: [{ name: "commonName", value: options.wwdrName ?? ISSUER_CN }],
    issuer: [{ name: "commonName", value: options.wwdrName ?? ISSUER_CN }],
    publicKey: issuerKeys.publicKey,
    signWith: issuerKeys.privateKey,
    notAfter: new Date("2030-01-01T00:00:00Z"),
  });
  const leaf = certificate({
    subject: [
      { name: "commonName", value: `Pass Type ID: ${options.passType ?? PASS_TYPE}` },
      { type: "0.9.2342.19200300.100.1.1", value: options.passType ?? PASS_TYPE },
    ],
    issuer: issuerAttrs,
    publicKey: leafKeys.publicKey,
    signWith: issuerKeys.privateKey,
    notAfter: options.notAfter ?? new Date("2030-01-01T00:00:00Z"),
  });
  return {
    APPLE_PASS_CERT_PEM: forge.pki.certificateToPem(leaf),
    APPLE_PASS_KEY_PEM: forge.pki.privateKeyToPem(
      options.mismatchedKey ? otherKeys.privateKey : leafKeys.privateKey,
    ),
    APPLE_WWDR_CERT_PEM: forge.pki.certificateToPem(wwdr),
  };
}

const WEBHOOK_DESTINATION = "https://card.losverd.es/bigcommerce/order-webhook";

interface RemoteState {
  classStatus: number;
  storeStatus: number;
  ordersStatus: number;
  hooksStatus: number;
  hooks: unknown[];
}

/**
 * Both external APIs the checks talk to. Mutated in place by a test that
 * wants one of them to answer differently, so the healthy defaults only have
 * to be stated once.
 */
let remote: RemoteState;

async function registeredAuthorization() {
  return `bearer ${await signWebhookToken(env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY, env.BIGCOMMERCE_STORE_HASH, env.BIGCOMMERCE_CLIENT_ID)}`;
}

function mockRemotes() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_OAUTH_TOKEN_URL) return Response.json({ access_token: "token" });
    if (url.startsWith(`${GOOGLE_WALLET_API}/genericClass`))
      return new Response("{}", { status: remote.classStatus });
    if (url.endsWith("/v2/orders/count"))
      return new Response(JSON.stringify({ count: 1234 }), { status: remote.ordersStatus });
    if (url.endsWith("/v2/store"))
      return new Response(JSON.stringify({ name: "Los Verdes", domain: "shop.example" }), {
        status: remote.storeStatus,
      });
    if (url.endsWith("/v3/hooks"))
      return new Response(JSON.stringify({ data: remote.hooks }), { status: remote.hooksStatus });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Every check green, so a test only has to break the one thing it's about. */
async function configureHealthyEnvironment() {
  Object.assign(env, healthyChain);
  env.PUBLIC_BASE_URL = "https://card.losverd.es";
  env.PASSKIT_WEB_SERVICE_URL = "https://card.losverd.es/passkit";
  env.PASSKIT_PASS_TYPE_IDENTIFIER = PASS_TYPE;
  env.BIGCOMMERCE_CLIENT_ID = "a-real-looking-client-id";
  env.APNS_KEY_ID = "ABCDE12345";
  env.APNS_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----";
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = "wallet@example.iam.gserviceaccount.com";
  env.GOOGLE_WALLET_PRIVATE_KEY_PEM = googleWalletKeyPem;
  // Stated rather than inherited from wrangler.toml, which sets it per
  // environment. A "fully configured" environment is one that can email
  // somebody.
  env.EMAIL_RECIPIENT_ALLOWLIST = "*";
  env.EMAIL = fakeEmailBinding();
  env.TURNSTILE_SITE_KEY = "0x000";
  env.TURNSTILE_SECRET_KEY = "0x111";
  env.CARD_EMAIL_NEW_ORDERS_SINCE = "";
  env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.example/T/B/X";
  env.SLACK_BOT_TOKEN = "xoxb-test";
  env.AUTH_GOOGLE_ID = "google-id";
  env.AUTH_GOOGLE_SECRET = "google-secret";
  env.APPLE_SIGNIN_KEY_ID = "SIGNIN123";
  env.APPLE_SIGNIN_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----";
  // `env` is shared across a file's tests and nothing restores it, so every
  // var a test might break has to be set back here, not just the ones a given
  // case cares about.
  env.ETL_SYNC_QUEUE_NAME = "etl-sync-production";
  env.ETL_SYNC_DLQ_NAME = "etl-sync-dlq-production";
  env.BIGCOMMERCE_STORE_HASH = "storehash";
  env.BIGCOMMERCE_ACCESS_TOKEN = "bc-access-token";
  env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY = "bc-signing-key";
  for (const key of TEMPLATE_KEYS) await env.ASSETS.put(key, "png-bytes");
  remote = {
    classStatus: 200,
    storeStatus: 200,
    ordersStatus: 200,
    hooksStatus: 200,
    hooks: [
      {
        scope: "store/order/*",
        destination: WEBHOOK_DESTINATION,
        is_active: true,
        headers: { Authorization: await registeredAuthorization() },
      },
    ],
  };
}

/** All results across every group, flattened -- most assertions want this. */
async function check(
  url: string | null = "https://card.losverd.es/admin/preflight",
  now = new Date("2026-09-18T00:00:00Z"),
) {
  const groups = await runPreflightChecks(env, url, now);
  return groups.flatMap((group) => group.results);
}

const find = (results: Awaited<ReturnType<typeof check>>, name: string) => {
  const result = results.find((each) => each.name === name);
  if (!result) throw new Error(`no check named "${name}"`);
  return result;
};

beforeEach(async () => {
  env.SESSION_SIGNING_KEY = SESSION_KEY;
  resetGoogleWalletTokenCache();
  await configureHealthyEnvironment();
  mockRemotes();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'admin@example.com', 1)").bind(ADMIN_ID).run();
  await env.DB.prepare("INSERT INTO users (id, email, is_admin) VALUES (?, 'member@example.com', 0)").bind(MEMBER_ID).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of TEMPLATE_KEYS) await env.ASSETS.delete(key);
  await env.DB.exec("DELETE FROM membership_orders");
  await env.DB.exec("DELETE FROM legacy_membership_cards");
  await env.DB.exec("DELETE FROM etl_sync_state");
  await env.DB.exec("DELETE FROM users");
});

describe("originVerdict", () => {
  it("passes when the configured origin is the one serving the page", () => {
    const result = originVerdict("https://card.losverd.es", "https://card.losverd.es");
    expect(result.status).toBe("ok");
  });

  it("fails on a mismatch whichever host is serving, now that both environments have their own", () => {
    // This used to be the pre-cutover norm, while production was reachable
    // only at its workers.dev host. Since #148 staging has a custom domain
    // too, so nothing should be served from workers.dev at all.
    const result = originVerdict(
      "https://card.losverd.es",
      "https://card-losverd-es-production.los-verdes.workers.dev",
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("card.losverd.es");
  });

  it("fails when the custom domain serves a Worker still configured for another origin", () => {
    // Being served at the custom domain is proof cutover happened, so the
    // configuration disagreeing with it is the mistake this check exists for.
    const result = originVerdict(
      "https://card-losverd-es-production.los-verdes.workers.dev",
      "https://card.losverd.es",
    );
    expect(result.status).toBe("fail");
  });

  it("leaves staging green, since it is configured for the host serving it", () => {
    const staging = "https://stagingcard.losverd.es";
    expect(originVerdict(staging, staging).status).toBe("ok");
  });

  it("fails on an unset or unparseable value", () => {
    expect(originVerdict("", "https://card.losverd.es").status).toBe("fail");
    expect(originVerdict("not-a-url", "https://card.losverd.es").detail).toContain("not a URL");
  });
});

describe("a fully configured environment", () => {
  it("reports nothing failing", async () => {
    const results = await check();
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
  });

  it("counts rows without naming any member", async () => {
    const detail = find(await check(), "D1 row counts").detail;
    expect(detail).toContain("members 0");
    expect(detail).toContain("membership_orders 0");
  });

  it("treats new-order card emails as deliberately off, not as a problem", async () => {
    // Warning on this would train us to ignore warnings; calling it OK would
    // hide the one setting that can mail the whole membership.
    expect(find(await check(), "New-order card emails").status).toBe("skip");
  });
});

describe("Apple pass signing", () => {
  it("catches a certificate bundled with the wrong WWDR generation", async () => {
    Object.assign(env, appleChain({ wwdrName: "Apple WWDR CA (a different generation)" }));
    expect(find(await check(), "Certificate chain").status).toBe("fail");
  });

  it("catches a private key that isn't the certificate's", async () => {
    Object.assign(env, appleChain({ mismatchedKey: true }));
    const result = find(await check(), "Key matches certificate");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("will not verify");
  });

  it("catches a certificate issued for a different pass type", async () => {
    Object.assign(env, appleChain({ passType: "pass.example.other" }));
    const result = find(await check(), "Pass type identifier");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("pass.example.other");
  });

  it("warns before the certificate expires, and fails after", async () => {
    const now = new Date("2026-09-18T00:00:00Z");
    const soon = new Date(now.getTime() + (CERT_EXPIRY_WARN_DAYS - 1) * 86_400_000);
    Object.assign(env, appleChain({ notAfter: soon }));
    expect(find(await check(undefined, now), "Certificate expiry").status).toBe("warn");

    Object.assign(env, appleChain({ notAfter: new Date(now.getTime() - 86_400_000) }));
    expect(find(await check(undefined, now), "Certificate expiry").status).toBe("fail");
  });

  it("names the missing secrets rather than every downstream check", async () => {
    env.APPLE_PASS_KEY_PEM = "";
    const results = await check();
    const result = find(results, "Signing credentials");
    expect(result.detail).toContain("APPLE_PASS_KEY_PEM");
    expect(results.some((each) => each.name === "Certificate expiry")).toBe(false);
  });

  it("reports an unparseable certificate as a finding, not a 500", async () => {
    env.APPLE_PASS_CERT_PEM = "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----";
    expect(find(await check(), "Certificate chain").status).toBe("fail");
  });

  it("warns when pass updates can't be pushed", async () => {
    env.APNS_KEY_ID = undefined;
    expect(find(await check(), "APNs push credentials").status).toBe("warn");
  });
});

describe("Google Wallet", () => {
  it("fails when the class does not exist under this issuer", async () => {
    remote.classStatus = 404;
    const result = find(await check(), "Wallet class");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("google-wallet-ensure-class");
  });

  it("points at the detailed checker for anything else Google says", async () => {
    remote.classStatus = 403;
    expect(find(await check(), "Wallet class").detail).toContain("google-wallet-check");
  });

  it("reports unconfigured credentials without calling Google", async () => {
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
    expect(find(await check(), "Service account").status).toBe("fail");
  });
});

describe("BigCommerce", () => {
  /** The pre-cutover view: reachable at workers.dev, configured for the real domain. */
  const PRE_CUTOVER = "https://card-losverd-es-production.los-verdes.workers.dev/admin/preflight";

  it("names the store the token opens, so a misaimed environment shows up", async () => {
    const result = find(await check(), "Access token");
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("Los Verdes");
    expect(result.detail).toContain("1234");
  });

  it("passes a token scoped to orders but not to the store's own details", async () => {
    // The shape a correctly-scoped production token actually has. Reading
    // orders is all this Worker ever does; `/v2/store` needs BigCommerce's
    // separate "Information & Settings" scope, and probing it for the verdict
    // reported a working token as broken while the webhook tooling, on the
    // same token, was succeeding.
    remote.storeStatus = 403;

    const result = find(await check(), "Access token");

    expect(result.status).toBe("ok");
    expect(result.detail).not.toContain("Los Verdes");
    expect(result.detail).toContain("1234");
  });

  it("fails when the token cannot read orders, which is all it is for", async () => {
    remote.ordersStatus = 403;
    const result = find(await check(), "Access token");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Orders read scope");
  });

  it("still passes when fetching the store's name fails outright", async () => {
    // The name is fetched separately and is a nicety: the verdict comes from
    // the orders probe. A network failure on the way to it must leave the
    // check passing, not turn a working token into a failure.
    const spy = vi.mocked(globalThis.fetch);
    const answering = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v2/store")) throw new TypeError("network unreachable");
      return answering(input, init);
    });

    const result = find(await check(), "Access token");

    expect(result.status).toBe("ok");
    expect(result.detail).not.toContain("Los Verdes");
  });

  it("fails on a rejected token", async () => {
    remote.ordersStatus = 401;
    expect(find(await check(), "Access token").status).toBe("fail");
  });

  it("reports an unset token without calling BigCommerce", async () => {
    env.BIGCOMMERCE_ACCESS_TOKEN = "";
    const results = await check();
    expect(find(results, "Access token").status).toBe("fail");
    expect(results.some((each) => each.name === "Order webhook")).toBe(false);
  });

  it("fails when no subscription delivers to the configured origin", async () => {
    remote.hooks = [];
    const result = find(await check(), "Order webhook");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("bigcommerce-ensure-webhook");
  });

  it("fails on a subscription that exists but is switched off", async () => {
    remote.hooks = [
      { scope: "store/order/*", destination: WEBHOOK_DESTINATION, is_active: false, headers: {} },
    ];
    expect(find(await check(), "Order webhook").detail).toContain("inactive");
  });

  it("matches the destination against PUBLIC_BASE_URL, not the host being read from", async () => {
    // An admin reading the page at workers.dev before cutover must still see
    // the webhook that points where BigCommerce will deliver afterwards.
    expect(find(await check(PRE_CUTOVER), "Order webhook").status).toBe("ok");
  });

  it("fails when the subscription delivers somewhere other than this environment", async () => {
    // A hook left on a retired host delivers into nothing, and orders stop
    // arriving with nothing else looking wrong.
    remote.hooks = [
      {
        scope: "store/order/*",
        destination: "https://card-losverd-es-production.los-verdes.workers.dev/bigcommerce/order-webhook",
        is_active: true,
        headers: { Authorization: await registeredAuthorization() },
      },
    ];

    const result = find(await check(PRE_CUTOVER), "Order webhook");

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("just bigcommerce-ensure-webhook");
  });

  it("still fails once cutover has happened and nothing delivers to the real origin", async () => {
    remote.hooks = [
      {
        scope: "store/order/*",
        destination: "https://card-losverd-es-production.los-verdes.workers.dev/bigcommerce/order-webhook",
        is_active: true,
        headers: {},
      },
    ];

    // Served from PUBLIC_BASE_URL, so cutover is done and this is real.
    expect(find(await check(), "Order webhook").status).toBe("fail");
  });


  it("fails on a foreign webhook token once we are serving the real domain", async () => {
    // Same state, after the flip: every delivery is being rejected and orders
    // have stopped syncing.
    remote.hooks = [
      {
        scope: "store/order/*",
        destination: WEBHOOK_DESTINATION,
        is_active: true,
        headers: { Authorization: "bearer the-legacy-apps-token" },
      },
    ];
    const result = find(await check(), "Webhook token");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("just bigcommerce-ensure-webhook <env>");
  });

  it("fails on a foreign webhook token on a scheduled run too, where nobody is reading a page", async () => {
    // The weekly readiness post is built on these verdicts (#95), and a
    // subscription carrying a token this Worker does not verify means every
    // delivery is being rejected right now.
    remote.hooks = [
      {
        scope: "store/order/*",
        destination: WEBHOOK_DESTINATION,
        is_active: true,
        headers: { Authorization: "bearer the-legacy-apps-token" },
      },
    ];

    const result = find(await check(null), "Webhook token");

    expect(result.status).toBe("fail");
  });

  it("never reports either token's value", async () => {
    const ours = await registeredAuthorization();
    const details = (await check()).map((result) => result.detail).join("\n");
    expect(details).not.toContain(ours);
    expect(details).not.toContain(env.BIGCOMMERCE_ACCESS_TOKEN);
  });

  it("skips the token comparison when the webhook list could not be read", async () => {
    remote.hooksStatus = 500;
    const results = await check();
    expect(find(results, "Order webhook").status).toBe("fail");
    expect(find(results, "Webhook token").status).toBe("skip");
  });

  it("skips the token comparison when no subscription matches", async () => {
    remote.hooks = [{ scope: "store/order/*", destination: "https://elsewhere.example/hook" }];
    expect(find(await check(), "Webhook token").status).toBe("skip");
  });

  it("reads a lowercased authorization header too", async () => {
    remote.hooks = [
      {
        scope: "store/order/*",
        destination: WEBHOOK_DESTINATION,
        is_active: true,
        headers: { authorization: await registeredAuthorization() },
      },
    ];
    expect(find(await check(), "Webhook token").status).toBe("ok");
  });
});

describe("who we may email", () => {
  const PRE_CUTOVER = "https://card-losverd-es-production.los-verdes.workers.dev/admin/preflight";

  it("fails on an empty list, which is a service answering everyone with silence", async () => {
    // Both environments serve members, so this is the safety net for
    // forgetting to put the list back -- the one mistake emptying it invites.
    env.EMAIL_RECIPIENT_ALLOWLIST = "";

    const result = find(await check(), "Who we may email");

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("every card anyone asks for is suppressed");
  });

  it("is content either way once it permits anybody", async () => {
    env.EMAIL_RECIPIENT_ALLOWLIST = "*";
    expect(find(await check(), "Who we may email").status).toBe("ok");
    expect(find(await check(PRE_CUTOVER), "Who we may email").status).toBe("ok");
  });

  it("names the addresses a restricted environment may reach", async () => {
    env.EMAIL_RECIPIENT_ALLOWLIST = "losverd.es";
    const result = find(await check(), "Who we may email");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("losverd.es");
  });
});

describe("storage", () => {
  it("names the template assets an environment's bucket is missing", async () => {
    await env.ASSETS.delete("templates/apple/logo@2x.png");
    const result = find(await check(), "R2 template assets");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("logo@2x.png");
    expect(result.detail).toContain("r2-upload-templates");
  });
});

describe("configuration", () => {
  it("catches the BigCommerce client id placeholder", async () => {
    env.BIGCOMMERCE_CLIENT_ID = "REPLACE_WITH_BIGCOMMERCE_CLIENT_ID";
    expect(find(await check(), "BigCommerce client id").status).toBe("fail");
  });

  it("catches a pass web service URL on a different origin", async () => {
    env.PASSKIT_WEB_SERVICE_URL = "https://card-losverd-es-production.los-verdes.workers.dev/passkit";
    const result = find(await check(), "Pass web service URL");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("poll a different host");
  });

  it("fails when either URL is unset", async () => {
    env.PASSKIT_WEB_SERVICE_URL = "";
    expect(find(await check(), "Pass web service URL").status).toBe("fail");
  });

  it("catches half-configured Turnstile", async () => {
    env.TURNSTILE_SECRET_KEY = undefined;
    expect(find(await check(), "Email a card to myself").status).toBe("fail");
  });

  it("expects no widget at all to be a warning, not a failure", async () => {
    env.TURNSTILE_SITE_KEY = "";
    env.TURNSTILE_SECRET_KEY = undefined;
    expect(find(await check(), "Email a card to myself").status).toBe("warn");
  });

  it("reports a configured send date", async () => {
    env.CARD_EMAIL_NEW_ORDERS_SINCE = "2026-10-01";
    expect(find(await check(), "New-order card emails").status).toBe("ok");
  });

  it("fails when nobody could log in", async () => {
    env.AUTH_GOOGLE_ID = undefined;
    env.APPLE_SIGNIN_KEY_ID = undefined;
    expect(find(await check(), "Sign-in providers").status).toBe("fail");
  });

  it("warns on missing Slack configuration", async () => {
    env.SLACK_ALERT_WEBHOOK_URL = undefined;
    env.SLACK_BOT_TOKEN = undefined;
    const results = await check();
    expect(find(results, "Slack alerts").status).toBe("warn");
    expect(find(results, "Slack member ETL").status).toBe("warn");
  });

  it("warns when the order resync has never completed here", async () => {
    expect(find(await check(), "Order resync").status).toBe("warn");
  });

  it("passes on a recent resync, and warns once two runs have been missed", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const record = async (lastRunAt: number) =>
      env.DB.prepare(
        // Both columns, as setWatermark does: the freshness signal reads
        // updated_at, the moment the job finished.
        `INSERT INTO etl_sync_state (job_name, last_run_at, updated_at) VALUES ('sync_subscriptions_etl', ?, ?)
         ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
      )
        .bind(lastRunAt, lastRunAt)
        .run();

    await record(now.getTime() - 2 * 3_600_000);
    expect(find(await check(undefined, now), "Order resync").status).toBe("ok");

    // Six-hourly, so twelve hours means two runs went missing.
    await record(now.getTime() - 20 * 3_600_000);
    const stale = find(await check(undefined, now), "Order resync");
    expect(stale.status).toBe("warn");
    expect(stale.detail).toContain("20 hours ago");
  });

  it("catches queue names that disagree about which environment they serve", async () => {
    env.ETL_SYNC_DLQ_NAME = "etl-sync-dlq-staging";
    env.ETL_SYNC_QUEUE_NAME = "etl-sync-production";
    expect(find(await check(), "Queue names").status).toBe("fail");
  });

  it("passes when both queue names name the same environment", async () => {
    expect(find(await check(), "Queue names").status).toBe("ok");
    expect(find(await check(), "Queue producer binding").status).toBe("ok");
  });
});

describe("the readiness page", () => {
  async function get(loggedInAs: number | null = ADMIN_ID) {
    const headers = new Headers();
    if (loggedInAs !== null) {
      const token = await issueSessionToken(SESSION_KEY, {
        userId: loggedInAs,
        isAdmin: loggedInAs === ADMIN_ID,
      });
      headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
    }
    return worker.fetch(
      new Request("https://card.losverd.es/admin/preflight", { headers, redirect: "manual" }),
      env,
      createExecutionContext(),
    );
  }

  it("is admin-only", async () => {
    expect((await get(null)).status).toBe(302);
    expect((await get(MEMBER_ID)).status).toBe(403);
  });

  it("still renders when the environment is barely configured at all", async () => {
    // The case this page exists for. A single unguarded throw anywhere in the
    // checks would replace the whole diagnosis with an error page, exactly
    // when it is needed.
    env.PUBLIC_BASE_URL = "";
    env.PASSKIT_WEB_SERVICE_URL = "";
    env.APPLE_PASS_CERT_PEM = "";
    env.APPLE_PASS_KEY_PEM = "";
    env.APPLE_WWDR_CERT_PEM = "";
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL = undefined;
    env.GOOGLE_WALLET_PRIVATE_KEY_PEM = undefined;
    env.BIGCOMMERCE_CLIENT_ID = "";
    env.EMAIL = undefined;
    env.AUTH_GOOGLE_ID = undefined;
    env.APPLE_SIGNIN_KEY_ID = undefined;

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Still needs a person");
  });

  it("renders every group and the steps that still need a person", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Apple pass signing");
    expect(body).toContain("Google Wallet");
    expect(body).toContain("Still needs a person");
    expect(body).toContain("0 failing");
  });

  it("makes each manual step tickable, for keeping your place", async () => {
    const body = await (await get()).text();

    // One checkbox per step, each wrapped in a label so the text is part of
    // the hit target -- these get worked through on a phone beside a laptop.
    const checkboxes = body.match(/<input type="checkbox"/g) ?? [];
    expect(checkboxes).toHaveLength(MANUAL_STEPS.length);
    expect(body).toContain("<label>");
  });

  it("says plainly that ticking is not saved", async () => {
    // There is no JavaScript and no storage here, so a reload starts over.
    // Someone part-way down a cutover checklist needs to know that before
    // they rely on it, not after.
    expect(await (await get()).text()).toContain("nothing is saved");
  });

  it("counts failures at the top so the page can be read at a glance", async () => {
    // Deliberately a self-contained break: the client id, say, also feeds the
    // derived webhook token, so breaking it would fail two checks at once.
    await env.ASSETS.delete("templates/card/crest.png");
    expect(await (await get()).text()).toContain("1 failing");
  });
});
