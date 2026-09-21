/**
 * Readiness checks the Worker runs against its own deployment.
 *
 * These exist because of what validating staging by hand actually cost. Every
 * problem found there -- a private key stored with literal `\n` escapes, a
 * template image never uploaded to R2, a Wallet class that didn't exist, a
 * Turnstile widget bound to the wrong hostname -- was invisible from outside
 * the Worker. Each one surfaced as a generic error page, or as a provider's
 * own generic failure, hours after the deploy that introduced it. The code
 * that can tell the difference is the code that parses the credential and
 * reads the binding, and that code runs here.
 *
 * Two rules hold throughout:
 *
 * 1. **Never report a secret's value.** Presence, shape, expiry, and the
 *    identifiers already public in an issued pass are fair game; bytes of a
 *    key are not. The page these render on is admin-only, but a screenshot of
 *    it shouldn't be a credential leak.
 * 2. **Read, never write.** A readiness check that creates a Wallet class or
 *    uploads an asset would be a deploy step wearing a checklist's clothes,
 *    and would report success for a state it had just manufactured.
 */

import forge from "node-forge";
import { signWebhookToken } from "../bigcommerce/webhookToken";
import { GOOGLE_WALLET_API, getGoogleWalletAccessToken } from "../google/api";
import {
  ALLOW_ANY_RECIPIENT,
  parseRecipientAllowlist,
} from "../email/send";
import type { Env } from "../index";
import { COUNTS_AS_MEMBERSHIP } from "../lib/membershipOrders";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** One line, safe to read aloud: what was found, and what to do about it. */
  detail: string;
}

export interface CheckGroup {
  title: string;
  results: CheckResult[];
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });
const skip = (name: string, detail: string): CheckResult => ({ name, status: "skip", detail });

/** A check's own exception is a finding, not a 500 on the readiness page. */
async function attempt(
  name: string,
  run: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    return fail(name, `Check itself failed: ${String(error)}`);
  }
}

/**
 * How many days of certificate life left before it's worth saying so. Apple
 * issues pass certificates for a year, and renewing one takes a console visit
 * plus `just apple-pass-cert-csr`/`-install`, so a month's notice is enough to
 * do it calmly and not so much that the warning becomes background noise.
 * Matches the threshold `scripts/apple-pass-cert.mjs` warns at.
 */
export const CERT_EXPIRY_WARN_DAYS = 30;

/** RFC 4519 `uid`. node-forge has no short name for it, so ask by OID. */
const UID_OID = "0.9.2342.19200300.100.1.1";

export function daysUntil(when: Date, now: Date): number {
  return Math.floor((when.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Whether `PUBLIC_BASE_URL` agreeing (or not) with the host actually serving
 * this request is worth flagging.
 *
 * This is the check that would catch the worst cutover mistake available to
 * us: `PUBLIC_BASE_URL` is baked into every QR code we sign and every pass we
 * issue, so a production Worker still claiming a `workers.dev` origin after
 * DNS moves would mint cards pointing at a hostname we intend to retire --
 * and nothing would look broken until those cards were scanned.
 *
 * The wrinkle is that a mismatch is *normal* before cutover. Production is
 * deployed and reachable at
 * `card-losverd-es-production.los-verdes.workers.dev` while `card.losverd.es`
 * still resolves to the legacy stack, and that is the expected state for
 * every pre-cutover run of this page.
 *
 * So the verdict turns on which side of the mismatch the `workers.dev` host
 * is on, which is the one thing here that *is* unambiguous. Being served at a
 * `workers.dev` host while configured for a custom domain is the pre-cutover
 * norm, and only worth a note. Being served at the custom domain is proof
 * cutover has happened -- at which point the configuration disagreeing with
 * it is the failure this check exists for.
 */
export function originVerdict(
  publicBaseUrl: string,
  requestOrigin: string,
): CheckResult {
  const name = "Public base URL";
  let configured: string;
  try {
    configured = new URL(publicBaseUrl).origin;
  } catch {
    return fail(name, `PUBLIC_BASE_URL is ${publicBaseUrl ? `"${publicBaseUrl}", which is not a URL` : "unset"}. Signed /verify-pass URLs cannot be built.`);
  }
  if (configured === requestOrigin) {
    return ok(name, `${configured} -- the host serving this page.`);
  }
  if (requestOrigin.endsWith(".workers.dev")) {
    return warn(
      name,
      `Configured as ${configured} but served from ${requestOrigin}. Expected before cutover; note that passes and QR codes issued now already point at ${configured}.`,
    );
  }
  return fail(
    name,
    `Served from ${requestOrigin} but PUBLIC_BASE_URL is ${configured}. Cutover has happened and the configuration hasn't followed: cards signed here point at a host we don't intend to keep serving.`,
  );
}

async function identityChecks(
  env: Env,
  requestUrl: string | null,
): Promise<CheckGroup> {
  const results: CheckResult[] = [];

  // `null` means nobody asked for this page -- a scheduled run. There is no
  // origin to compare against, and comparing PUBLIC_BASE_URL with itself
  // would manufacture an "ok" that means nothing.
  results.push(
    requestUrl === null
      ? skip(
          "Public base URL",
          "Not checked -- this ran on a schedule, so there is no request to compare the configured origin against.",
        )
      : originVerdict(env.PUBLIC_BASE_URL ?? "", new URL(requestUrl).origin),
  );

  // Apple appends `/v1/...` to whatever `webServiceURL` a pass declares, and
  // asks for updates there for as long as the pass is installed. Pointing it
  // at a different origin than the rest of the service is how a pass keeps
  // polling a host we've stopped serving.
  const webService = env.PASSKIT_WEB_SERVICE_URL ?? "";
  const base = env.PUBLIC_BASE_URL ?? "";
  if (!webService || !base) {
    results.push(fail("Pass web service URL", "PASSKIT_WEB_SERVICE_URL or PUBLIC_BASE_URL is unset."));
  } else if (new URL(webService).origin !== new URL(base).origin) {
    results.push(
      fail(
        "Pass web service URL",
        `PASSKIT_WEB_SERVICE_URL is on ${new URL(webService).origin}, but PUBLIC_BASE_URL is ${new URL(base).origin}. Installed passes would poll a different host than the one issuing them.`,
      ),
    );
  } else {
    results.push(ok("Pass web service URL", `${webService} -- same origin as PUBLIC_BASE_URL.`));
  }

  // wrangler.toml ships a literal placeholder for this until the real app
  // credentials are in place; the token is scoped to the client id, so a
  // placeholder means every BigCommerce call fails authentication.
  const clientId = env.BIGCOMMERCE_CLIENT_ID ?? "";
  results.push(
    clientId && !clientId.startsWith("REPLACE_WITH")
      ? ok("BigCommerce client id", `Set (store ${env.BIGCOMMERCE_STORE_HASH}).`)
      : fail("BigCommerce client id", "Still the wrangler.toml placeholder; BigCommerce calls cannot authenticate."),
  );

  return { title: "Identity and origin", results };
}

/** Tables every route assumes; a missing one means migrations didn't apply. */
const EXPECTED_TABLES = [
  "card_emails",
  "devices",
  "etl_sync_state",
  "legacy_membership_cards",
  "member_since_overrides",
  "members",
  "membership_order_attributions",
  "membership_orders",
  "oauth_identities",
  "pass_device_logs",
  "rate_limit_counters",
  "registrations",
  "slack_users",
  "users",
];

/**
 * Row counts worth eyeballing before cutover, as a sanity check on the legacy
 * import and the first full resync. Counts only -- never a row.
 */
const COUNTED_TABLES = ["members", "membership_orders", "legacy_membership_cards", "users"];

async function storageChecks(env: Env): Promise<CheckGroup> {
  const results: CheckResult[] = [];

  results.push(
    await attempt("D1 migrations", async () => {
      const { results: rows } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all<{ name: string }>();
      const present = new Set(rows.map((row) => row.name));
      const missing = EXPECTED_TABLES.filter((name) => !present.has(name));
      return missing.length === 0
        ? ok("D1 migrations", `All ${EXPECTED_TABLES.length} expected tables present.`)
        : fail(
            "D1 migrations",
            `Missing ${missing.join(", ")} -- run \`just db-migrate-remote\` for this environment.`,
          );
    }),
  );

  results.push(
    await attempt("D1 row counts", async () => {
      const counts: string[] = [];
      for (const table of COUNTED_TABLES) {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
        counts.push(`${table} ${row?.n ?? 0}`);
      }
      return ok("D1 row counts", counts.join(", "));
    }),
  );

  // Pass generation reads these from R2 at issue time, so an environment whose
  // bucket was never populated signs passes right up to the point of failing.
  const templateKeys = [
    "templates/apple/icon.png",
    "templates/apple/icon@2x.png",
    "templates/apple/logo.png",
    "templates/apple/logo@2x.png",
    "templates/card/crest.png",
  ];
  results.push(
    await attempt("R2 template assets", async () => {
      const missing: string[] = [];
      for (const key of templateKeys) {
        if (!(await env.ASSETS.head(key))) missing.push(key);
      }
      return missing.length === 0
        ? ok("R2 template assets", `All ${templateKeys.length} present.`)
        : fail(
            "R2 template assets",
            `Missing ${missing.join(", ")} -- run \`just r2-upload-templates\` for this environment.`,
          );
    }),
  );

  return { title: "Storage", results };
}

async function applePassChecks(env: Env, now: Date): Promise<CheckGroup> {
  const results: CheckResult[] = [];
  const { APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM, APPLE_WWDR_CERT_PEM } = env;

  if (!APPLE_PASS_CERT_PEM || !APPLE_PASS_KEY_PEM || !APPLE_WWDR_CERT_PEM) {
    const absent = [
      ["APPLE_PASS_CERT_PEM", APPLE_PASS_CERT_PEM],
      ["APPLE_PASS_KEY_PEM", APPLE_PASS_KEY_PEM],
      ["APPLE_WWDR_CERT_PEM", APPLE_WWDR_CERT_PEM],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    return {
      title: "Apple pass signing",
      results: [fail("Signing credentials", `Unset: ${absent.join(", ")}. Apple passes cannot be issued.`)],
    };
  }

  results.push(
    await attempt("Certificate chain", async () => {
      const cert = forge.pki.certificateFromPem(APPLE_PASS_CERT_PEM);
      const wwdr = forge.pki.certificateFromPem(APPLE_WWDR_CERT_PEM);
      // Apple has issued several WWDR generations. A leaf bundled with the
      // wrong one produces a pass iOS declines without explanation.
      const issuer = cert.issuer.getField("CN")?.value ?? "";
      const wwdrSubject = wwdr.subject.getField("CN")?.value ?? "";
      return issuer === wwdrSubject
        ? ok("Certificate chain", `Leaf issued by "${wwdrSubject}", which is the bundled intermediate.`)
        : fail(
            "Certificate chain",
            `Leaf's issuer is "${issuer}" but the bundled intermediate is "${wwdrSubject}". Re-run \`just apple-pass-cert-install\`, which fetches the matching generation.`,
          );
    }),
  );

  results.push(
    await attempt("Key matches certificate", async () => {
      const cert = forge.pki.certificateFromPem(APPLE_PASS_CERT_PEM);
      const key = forge.pki.privateKeyFromPem(APPLE_PASS_KEY_PEM) as forge.pki.rsa.PrivateKey;
      const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
      return publicKey.n.equals(key.n)
        ? ok("Key matches certificate", "The stored key is the one this certificate was issued for.")
        : fail(
            "Key matches certificate",
            "The stored private key does not match the certificate. Signatures produced here will not verify.",
          );
    }),
  );

  results.push(
    await attempt("Pass type identifier", async () => {
      const cert = forge.pki.certificateFromPem(APPLE_PASS_CERT_PEM);
      const uid = cert.subject.attributes.find((attribute) => attribute.type === UID_OID);
      const certPassType = String(uid?.value ?? "");
      const configured = env.PASSKIT_PASS_TYPE_IDENTIFIER;
      return certPassType === configured
        ? ok("Pass type identifier", `Certificate and configuration agree on ${configured}.`)
        : fail(
            "Pass type identifier",
            `Certificate is for "${certPassType || "(none found)"}" but PASSKIT_PASS_TYPE_IDENTIFIER is "${configured}".`,
          );
    }),
  );

  results.push(
    await attempt("Certificate expiry", async () => {
      const cert = forge.pki.certificateFromPem(APPLE_PASS_CERT_PEM);
      const left = daysUntil(cert.validity.notAfter, now);
      const on = cert.validity.notAfter.toISOString().slice(0, 10);
      if (left < 0) return fail("Certificate expiry", `Expired on ${on}. Passes cannot be signed.`);
      if (left <= CERT_EXPIRY_WARN_DAYS)
        return warn("Certificate expiry", `Expires ${on}, in ${left} days. Renew with \`just apple-pass-cert-csr\`.`);
      return ok("Certificate expiry", `Valid until ${on} (${left} days).`);
    }),
  );

  // Optional: without it, a changed membership simply doesn't reach the phone
  // until the member opens their card, which is a degraded service rather than
  // a broken one.
  const apns = env.APNS_KEY_ID && env.APNS_PRIVATE_KEY_PEM;
  results.push(
    apns
      ? ok("APNs push credentials", `Key ${env.APNS_KEY_ID} configured; pass updates will be pushed.`)
      : warn(
          "APNs push credentials",
          "APNS_KEY_ID/APNS_PRIVATE_KEY_PEM unset. Passes still issue, but installed ones won't be told to refresh.",
        ),
  );

  return { title: "Apple pass signing", results };
}

async function googleWalletChecks(env: Env): Promise<CheckGroup> {
  const email = env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL;
  const privateKeyPem = env.GOOGLE_WALLET_PRIVATE_KEY_PEM;
  if (!email || !privateKeyPem) {
    return {
      title: "Google Wallet",
      results: [
        fail(
          "Service account",
          "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL or GOOGLE_WALLET_PRIVATE_KEY_PEM unset; save links fail closed.",
        ),
      ],
    };
  }

  const classId = `${env.GOOGLE_WALLET_ISSUER_ID}.${env.GOOGLE_WALLET_CLASS_SUFFIX}`;
  const result = await attempt("Wallet class", async () => {
    // One call proves three things at once: the key parses, the service
    // account's credentials are accepted, and the class the Worker writes
    // objects against exists under this issuer.
    const token = await getGoogleWalletAccessToken({ serviceAccountEmail: email, privateKeyPem });
    const res = await fetch(`${GOOGLE_WALLET_API}/genericClass/${encodeURIComponent(classId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return ok("Wallet class", `${classId} exists and is readable by ${email}.`);
    if (res.status === 404)
      return fail(
        "Wallet class",
        `${classId} does not exist. Create it with \`just google-wallet-ensure-class <env>\`.`,
      );
    return fail("Wallet class", `Google answered ${res.status}. Run \`just google-wallet-check\` for the detail.`);
  });

  return { title: "Google Wallet", results: [result] };
}

function deliveryChecks(env: Env, live: boolean): CheckGroup {
  const results: CheckResult[] = [];

  // Reported on the page because "no email arrived" is otherwise a puzzle
  // with the answer in a config file. Never a failure: every one of the three
  // settings is a deliberate choice, including the one that sends nothing.
  const allowlist = parseRecipientAllowlist(env.EMAIL_RECIPIENT_ALLOWLIST);
  results.push(
    allowlist.includes(ALLOW_ANY_RECIPIENT)
      ? ok("Who we may email", "Any address (EMAIL_RECIPIENT_ALLOWLIST is `*`).")
      : allowlist.length === 0
        ? // Empty is a deliberate guard before cutover and a broken service
          // after it: this Worker is answering members, and /email-card is
          // replying to every one of them with silence.
          (live ? fail : warn)(
            "Who we may email",
            live
              ? "Nobody -- EMAIL_RECIPIENT_ALLOWLIST is empty while this Worker is serving members, so every card anyone asks for is suppressed. Set it to `*`."
              : "Nobody -- EMAIL_RECIPIENT_ALLOWLIST is empty, so every send is suppressed and logged. Deliberate before cutover; set it to `*` at the flip.",
          )
        : warn(
            "Who we may email",
            `Only ${allowlist.join(", ")}. Every other recipient is suppressed and logged, which is what makes realistic member data safe to hold here.`,
          ),
  );

  const turnstileSite = env.TURNSTILE_SITE_KEY;
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  if (turnstileSite && turnstileSecret && env.EMAIL) {
    results.push(
      ok("Email a card to myself", "The email binding and both Turnstile keys are set; /email-card is open."),
    );
  } else if (!turnstileSite && !turnstileSecret) {
    results.push(
      warn(
        "Email a card to myself",
        "No Turnstile widget for this environment, so /email-card fails closed. Expected until a widget exists for this hostname.",
      ),
    );
  } else {
    results.push(
      fail(
        "Email a card to myself",
        "Turnstile is half-configured (one of the site/secret key pair is missing), or this environment has no `send_email` binding named EMAIL.",
      ),
    );
  }

  // Deliberately empty until we're ready for new orders to mail a card;
  // a past date here during a backfill is how existing members get mailed.
  const since = env.CARD_EMAIL_NEW_ORDERS_SINCE;
  results.push(
    since
      ? ok("New-order card emails", `Sending for orders completed on or after ${since}.`)
      : skip("New-order card emails", "Off (CARD_EMAIL_NEW_ORDERS_SINCE empty). Set it to the day sending is switched on, never a past date."),
  );

  results.push(
    env.SLACK_ALERT_WEBHOOK_URL
      ? ok("Slack alerts", "Webhook configured; dead-lettered messages will be announced.")
      : warn("Slack alerts", "SLACK_ALERT_WEBHOOK_URL unset -- a dead-lettered sync would be noticed only in Workers Logs."),
  );

  results.push(
    env.SLACK_BOT_TOKEN
      ? ok("Slack member ETL", "Bot token configured.")
      : warn("Slack member ETL", "SLACK_BOT_TOKEN unset; the Slack cross-reference report will be empty."),
  );

  const providers = [
    env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET ? "Google" : null,
    env.APPLE_SIGNIN_KEY_ID && env.APPLE_SIGNIN_PRIVATE_KEY_PEM ? "Apple" : null,
  ].filter(Boolean);
  results.push(
    providers.length > 0
      ? ok("Sign-in providers", `${providers.join(" and ")} configured.`)
      : fail("Sign-in providers", "Neither Google nor Apple sign-in is configured; nobody can log in."),
  );

  return { title: "Member-facing integrations", results };
}

/**
 * Whether the one-time legacy import left anybody without a membership they
 * ought to have.
 *
 * `COUNTS_AS_MEMBERSHIP` applies a paid-only allow-list to `bigcommerce`
 * rows, and plenty of imported orders fail it -- abandoned carts, mostly.
 * That on its own says nothing: somebody who abandoned a cart in 2024 and
 * bought a membership in 2025 holds a card either way. What matters is the
 * person left holding *no* counted order at all, and only that number is
 * worth putting in front of a reader.
 *
 * Reporting the raw order count instead read as a crisis -- "1410 orders
 * across 544 addresses" -- with an answer of zero underneath it, on a page
 * whose value depends entirely on being believed.
 *
 * The last step is the one that makes this an answer rather than a prompt.
 * Somebody left with no counted order is only a problem if the previous site
 * thought they were a member, and whether it did is knowable here:
 * `legacy_membership_cards` holds every card that site ever issued. So the
 * check joins it rather than telling a reader to go and look. See
 * los-verdes/card-losverd-es#89, which this measurement settled.
 */
async function legacyImportChecks(env: Env): Promise<CheckGroup> {
  const label = "Members left behind by the import";
  const result = await attempt(label, async () => {
    // Evaluated once per row in a CTE: the shared rule reads unqualified
    // `source` and `status`, so it has to sit against a bare
    // `membership_orders` rather than an alias. Safe to compare against 0
    // because the rule is two-valued (#107).
    const row = await env.DB.prepare(
      `WITH counted AS (
         SELECT member_email, first_seen_via, source, ${COUNTS_AS_MEMBERSHIP} AS counts
           FROM membership_orders
       ),
       imported AS (
         SELECT * FROM counted WHERE first_seen_via = 'legacy_postgres' AND source = 'bigcommerce'
       ),
       stranded AS (
         SELECT DISTINCT member_email FROM imported i
          WHERE i.counts = 0
            AND NOT EXISTS (
              SELECT 1 FROM counted c
               WHERE c.member_email = i.member_email AND c.counts = 1
            )
       )
       SELECT (SELECT COUNT(*) FROM imported) AS imported,
              (SELECT COUNT(*) FROM imported WHERE counts = 0) AS discarded,
              (SELECT COUNT(DISTINCT member_email) FROM imported WHERE counts = 0) AS people,
              (SELECT COUNT(*) FROM stranded) AS stranded,
              (SELECT COUNT(*) FROM stranded
                WHERE member_email IN (SELECT email FROM legacy_membership_cards)) AS strandedWithCard`,
    ).first<{
      imported: number;
      discarded: number;
      people: number;
      stranded: number;
      strandedWithCard: number;
    }>();

    const imported = row?.imported ?? 0;
    if (imported === 0) {
      return skip(label, "No historical BigCommerce-era orders here yet -- run the legacy import first.");
    }
    const discarded = row?.discarded ?? 0;
    const stranded = row?.stranded ?? 0;
    const excluded =
      discarded === 0
        ? `All ${imported} imported BigCommerce-era orders carry a status that counts.`
        : `${discarded} of ${imported} imported BigCommerce-era orders fail the paid-only allow-list (abandoned carts, mostly), across ${row?.people ?? 0} ${row?.people === 1 ? "address" : "addresses"}.`;

    if (stranded === 0) {
      return ok(label, `${excluded} Nobody is left holding no counted order at all.`);
    }
    const withCard = row?.strandedWithCard ?? 0;
    if (withCard === 0) {
      // The reassuring case, and the common one: these orders never conferred
      // membership on the previous site either, so the rule agrees with it.
      return ok(
        label,
        `${excluded} ${stranded} ${stranded === 1 ? "address holds" : "addresses hold"} no counted order at all, but the previous site never issued ${stranded === 1 ? "that person" : "any of them"} a card either -- so this rule matches what they had.`,
      );
    }
    // A warning rather than a failure: the rule is working as written, and
    // what to do about a given person is a judgement rather than a fix.
    return warn(
      label,
      `${excluded} ${withCard} ${withCard === 1 ? "person was" : "people were"} issued a card by the previous site and ${withCard === 1 ? "holds" : "hold"} no counted order here, so ${withCard === 1 ? "that card goes" : "those cards go"} away at cutover. Settle before cutover: if the previous site treated them as members, the rule is what is wrong.`,
    );
  });
  return { title: "Legacy import", results: [result] };
}

const BC_API_BASE = "https://api.bigcommerce.com/stores";
const WEBHOOK_PATH = "/bigcommerce/order-webhook";
const WEBHOOK_SCOPE = "store/order/*";

interface BigCommerceHook {
  destination?: string;
  scope?: string;
  is_active?: boolean;
  headers?: Record<string, string>;
}

/**
 * Whether this store's order webhook will actually reach us, and be believed
 * when it does.
 *
 * The second half is the one worth automating. A webhook subscription carries
 * its `Authorization` header from the moment it was registered, so the
 * production store's subscription holds the *legacy* app's token right up
 * until someone updates it by hand after DNS moves -- at which point every
 * delivery is a 401 and orders quietly stop syncing. The plan calls this out
 * as a step to do "right after the flip", which is exactly the kind of step
 * that gets missed.
 *
 * `live` says whether this Worker is already serving its own
 * `PUBLIC_BASE_URL`. Before cutover a token mismatch is the expected state
 * and only worth noting; after it, it means orders are being dropped.
 */
/**
 * ` ("Shop Name")` when the token carries the "Information & Settings" scope,
 * and an empty string when it does not. Never fails the check it decorates:
 * the Worker never reads this endpoint, so a token without the scope is
 * correctly configured, not broken.
 */
async function storeLabel(
  storeHash: string,
  headers: Record<string, string>,
): Promise<string> {
  try {
    const res = await fetch(`${BC_API_BASE}/${storeHash}/v2/store`, { headers });
    if (!res.ok) return "";
    const store = await res.json<{ name?: string }>();
    return store.name ? ` ("${store.name}")` : "";
  } catch {
    return "";
  }
}

async function bigCommerceChecks(
  env: Env,
  live: boolean,
  requestUrl: string | null,
): Promise<CheckGroup> {
  const results: CheckResult[] = [];
  const { BIGCOMMERCE_STORE_HASH: storeHash, BIGCOMMERCE_ACCESS_TOKEN: accessToken } = env;

  if (!accessToken) {
    return {
      title: "BigCommerce",
      results: [fail("Access token", "BIGCOMMERCE_ACCESS_TOKEN unset; no order can be fetched or synced.")],
    };
  }

  const headers = { "X-Auth-Token": accessToken, Accept: "application/json" };

  results.push(
    await attempt("Access token", async () => {
      // Probes the capability this Worker actually needs. Everything it asks
      // BigCommerce for is an order (`/v2/orders*` in src/bigcommerce/sync.ts),
      // and BigCommerce scopes its tokens per resource.
      //
      // This used to probe `/v2/store`, which reads as the more natural "does
      // this credential work" question but needs the separate "Information &
      // Settings" scope. A token granted exactly what the Worker needs does
      // not carry it, so BigCommerce answered 403 and this reported a working
      // token as broken -- while `just bigcommerce-ensure-webhook`, on the
      // same token, succeeded. A check that fails on a capability nothing
      // uses teaches whoever reads it to disbelieve the page.
      const res = await fetch(`${BC_API_BASE}/${storeHash}/v2/orders/count`, { headers });
      if (!res.ok) {
        return fail(
          "Access token",
          res.status === 401 || res.status === 403
            ? `BigCommerce answered ${res.status} for store ${storeHash}. The token is rejected, or lacks the Orders read scope.`
            : `BigCommerce answered ${res.status} for store ${storeHash}.`,
        );
      }
      const { count } = await res.json<{ count?: number }>();
      const orders = typeof count === "number" ? `, ${count} order(s) visible` : "";
      // The store's name is worth seeing on a page that exists to catch an
      // environment pointed at the wrong shop, but it is a nicety rather than
      // the verdict: it needs a scope of its own, so it is shown when the
      // token happens to carry one and passed over in silence when it does not.
      return ok("Access token", `Accepted for store ${storeHash}${await storeLabel(storeHash, headers)}${orders}.`);
    }),
  );

  // Matched against PUBLIC_BASE_URL rather than the host serving this page:
  // the destination has to be where BigCommerce will deliver after cutover,
  // not where an admin happens to be reading from.
  //
  // Guarded rather than assumed. This page's whole purpose is to be readable
  // on a half-configured environment, so an unset PUBLIC_BASE_URL has to cost
  // two check results, not the entire page.
  let expected: string;
  try {
    expected = `${new URL(env.PUBLIC_BASE_URL).origin}${WEBHOOK_PATH}`;
  } catch {
    const detail = "PUBLIC_BASE_URL is unset or not a URL, so there is no destination to compare against.";
    results.push(fail("Order webhook", detail), skip("Webhook token", "Not checked -- see above."));
    return { title: "BigCommerce", results };
  }
  let hook: BigCommerceHook | undefined;
  let listed = false;

  results.push(
    await attempt("Order webhook", async () => {
      const res = await fetch(`${BC_API_BASE}/${storeHash}/v3/hooks`, { headers });
      if (!res.ok) return fail("Order webhook", `Could not list webhooks: BigCommerce answered ${res.status}.`);
      listed = true;
      const { data = [] } = await res.json<{ data?: BigCommerceHook[] }>();
      const subscribedTo = (destination: string) =>
        data.find((each) => each.destination === destination && each.scope === WEBHOOK_SCOPE);
      hook = subscribedTo(expected);
      if (!hook) {
        // Before cutover the subscription belongs on this Worker's own
        // origin, not on PUBLIC_BASE_URL: that is still the legacy app's
        // host, and `bigcommerce-ensure-webhook` refuses to take it over
        // until the flip. Finding it there is the arrangement working, so
        // reporting it as a failure would train a reader to scroll past the
        // one state that really is broken.
        const servingOrigin = requestUrl ? new URL(requestUrl).origin : null;
        const here = servingOrigin ? subscribedTo(`${servingOrigin}${WEBHOOK_PATH}`) : undefined;
        if (here && !live) {
          // Kept, so the token check below can still verify it. What that
          // subscription carries is worth knowing now rather than at cutover.
          hook = here;
          return warn(
            "Order webhook",
            `${WEBHOOK_SCOPE} delivers to ${here.destination} rather than ${expected}. Expected before cutover, while the legacy app still serves that origin; re-point it with \`just bigcommerce-ensure-webhook <env> --cutover\` as part of the flip.`,
          );
        }
        return fail(
          "Order webhook",
          `No ${WEBHOOK_SCOPE} subscription delivering to ${expected}. Register one with \`just bigcommerce-ensure-webhook\`.`,
        );
      }
      if (!hook.is_active) return fail("Order webhook", `The subscription for ${expected} exists but is inactive.`);
      return ok("Order webhook", `${WEBHOOK_SCOPE} delivers to ${expected}.`);
    }),
  );

  results.push(
    await attempt("Webhook token", async () => {
      if (!listed) return skip("Webhook token", "Not checked -- the webhook list could not be read.");
      if (!hook) return skip("Webhook token", "Not checked -- no subscription found for this origin.");
      // Compared, never reported: both sides are shared secrets.
      const ours = `bearer ${await signWebhookToken(env.BIGCOMMERCE_WEBHOOK_SIGNING_KEY, storeHash, env.BIGCOMMERCE_CLIENT_ID)}`;
      const registered = hook.headers?.Authorization ?? hook.headers?.authorization ?? "";
      if (registered === ours) return ok("Webhook token", "The registered header matches what this Worker verifies.");
      return live
        ? fail(
            "Webhook token",
            "The registered header is not what this Worker verifies, so every delivery is being rejected. Re-register with `just bigcommerce-ensure-webhook <env> --cutover`.",
          )
        : warn(
            "Webhook token",
            "The registered header is not this Worker's. Expected before cutover, while the subscription still carries the legacy app's token -- but it must be updated as part of the flip.",
          );
    }),
  );

  return { title: "BigCommerce", results };
}

/**
 * The order resync runs on a six-hourly cron, so two missed runs is the point
 * at which something is more likely wrong than merely late.
 */
export const SYNC_STALE_AFTER_HOURS = 12;
const SUBSCRIPTIONS_ETL_JOB_NAME = "sync_subscriptions_etl";

async function queueChecks(env: Env, now: Date): Promise<CheckGroup> {
  const results: CheckResult[] = [];
  results.push(
    env.ETL_SYNC_QUEUE
      ? ok("Queue producer binding", `Bound; batches route by name (${env.ETL_SYNC_QUEUE_NAME}).`)
      : fail("Queue producer binding", "ETL_SYNC_QUEUE is not bound -- webhooks and cron jobs cannot enqueue a sync."),
  );
  // The consumer dispatches on these names, so a mismatch between the binding
  // and the var means every batch hits the "no consumer registered" throw and
  // retries forever.
  const suffix = (name: string | undefined) => name?.split("-").pop() ?? "";
  results.push(
    env.ETL_SYNC_QUEUE_NAME && env.ETL_SYNC_DLQ_NAME && suffix(env.ETL_SYNC_QUEUE_NAME) === suffix(env.ETL_SYNC_DLQ_NAME)
      ? ok("Queue names", `${env.ETL_SYNC_QUEUE_NAME} and ${env.ETL_SYNC_DLQ_NAME}.`)
      : fail("Queue names", `ETL_SYNC_QUEUE_NAME (${env.ETL_SYNC_QUEUE_NAME}) and ETL_SYNC_DLQ_NAME (${env.ETL_SYNC_DLQ_NAME}) name different environments.`),
  );

  // The only job that records a watermark, and the one that matters: it is
  // what keeps D1 a faithful cache of the store's orders. A cron that was
  // never enabled and a cron that has been failing look the same from
  // outside, and both look like nothing at all.
  results.push(
    await attempt("Order resync", async () => {
      const row = await env.DB.prepare(
        "SELECT last_run_at FROM etl_sync_state WHERE job_name = ?",
      )
        .bind(SUBSCRIPTIONS_ETL_JOB_NAME)
        .first<{ last_run_at: number }>();
      if (!row) {
        return warn(
          "Order resync",
          "Has never completed here. Bringing an environment up includes enabling the cron triggers and running one full resync.",
        );
      }
      const hours = Math.floor((now.getTime() - row.last_run_at) / 3_600_000);
      const when = new Date(row.last_run_at).toISOString().replace("T", " ").slice(0, 16);
      return hours >= SYNC_STALE_AFTER_HOURS
        ? warn(
            "Order resync",
            `Last completed ${when}Z, ${hours} hours ago. It runs six-hourly, so this is either a cron that isn't enabled or one that is failing -- check the dead-letter alerts.`,
          )
        : ok("Order resync", `Last completed ${when}Z, ${hours} hours ago.`);
    }),
  );

  return { title: "Queues and scheduled work", results };
}

/**
 * Runs every automated check. Groups are ordered roughly by how early a
 * failure would stop cutover.
 */
export async function runPreflightChecks(
  env: Env,
  requestUrl: string | null,
  now: Date = new Date(),
): Promise<CheckGroup[]> {
  // Whether this Worker is already serving the origin it issues passes for.
  // Several checks read differently either side of that line -- a webhook
  // still carrying the legacy app's token is expected before cutover and
  // means dropped orders after it.
  //
  // A scheduled run (`requestUrl === null`) cannot tell: it has no request
  // whose host it could compare. It assumes pre-cutover, which is the
  // assumption that cannot raise a false alarm -- before cutover the strict
  // reading would report a deliberate, known state as a failure every time
  // it ran, and an alert that fires on a known-good state is one people
  // learn to ignore. The page, which does have a request, still reports the
  // strict verdict, and a post-cutover token mismatch also surfaces as the
  // order resync going stale.
  const live =
    requestUrl !== null &&
    originVerdict(env.PUBLIC_BASE_URL ?? "", new URL(requestUrl).origin).status === "ok";

  return [
    await identityChecks(env, requestUrl),
    await storageChecks(env),
    await legacyImportChecks(env),
    await applePassChecks(env, now),
    await googleWalletChecks(env),
    await bigCommerceChecks(env, live, requestUrl),
    deliveryChecks(env, live),
    await queueChecks(env, now),
  ];
}

/**
 * The steps no code can take for us. Kept beside the automated checks rather
 * than in a separate runbook, so there is one page to work down and no second
 * document to fall out of date.
 */
export const MANUAL_STEPS = [
  "Install a .pkpass on a real iPhone: check colours, logo, barcode and text, then change the membership and confirm the push wakes the device.",
  "Save a pass to Google Wallet on a real Android phone.",
  "Sign in with Google, and with Apple, from a browser that has never held a session here.",
  "Scan a QR code from a legacy pass or an emailed card image and confirm /verify-pass accepts it.",
  "Send yourself a card from /email-card and confirm it arrives.",
  "Compare the admin reports against the legacy report; they gate decommissioning, not just cutover.",
  "Spot-check a few early members' \"member since\" dates against the legacy import.",
  "Reconcile the member count above against BigCommerce's own admin, after the legacy import and a full resync.",
];
