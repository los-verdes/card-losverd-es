import { authHandler, initAuthConfig } from "@hono/auth-js";
import { Hono } from 'hono';
import adminMemberSince from "./admin/memberSince";
import adminOrders from "./admin/orders";
import adminPreflight from "./admin/preflight";
import adminReports from "./admin/reports";
import { authConfig, landOnSessionBridge } from "./auth/authjs";
import auth from "./auth/routes";
import assets from "./assets";
import bigcommerce from "./bigcommerce/routes";
import { handleServerError } from "./lib/serverError";
import claimMembership, { CLAIM_PATH } from "./member/claimMembership";
import emailCard from "./member/email-card";
import portal from "./member/portal";
import verifyPass from "./member/verify-pass";
import passkit from "./passkit/routes";
import { handleQueueBatch } from "./queues";
import type { EtlSyncMessage } from "./queues/etlSync";
import { scheduled } from "./scheduled";

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  BIGCOMMERCE_STORE_HASH: string;
  BIGCOMMERCE_CLIENT_ID: string;
  // Secrets (`wrangler secret put`, no wrangler.toml placeholders). Webhook
  // verification fails closed without the signing key.
  BIGCOMMERCE_ACCESS_TOKEN: string;
  BIGCOMMERCE_WEBHOOK_SIGNING_KEY: string;
  // etl-sync queue producer (Phase 2.5.2; terraform/queues.tf, wrangler.toml).
  ETL_SYNC_QUEUE: Queue<EtlSyncMessage>;
  // Not secret -- this environment's queue names, which src/queues/index.ts
  // routes batches by.
  ETL_SYNC_QUEUE_NAME: string;
  ETL_SYNC_DLQ_NAME: string;
  // Not secret -- what this environment calls itself in anything a person
  // reads (src/slack/alert.ts).
  ENVIRONMENT: string;
  // Not secret -- public pass/branding identifiers, see Phase 4.
  PASSKIT_PASS_TYPE_IDENTIFIER: string;
  PASSKIT_TEAM_IDENTIFIER: string;
  PASSKIT_ORGANIZATION_NAME: string;
  PASSKIT_WEB_SERVICE_URL: string;
  // Not secret -- this service's public origin (no trailing slash), used to
  // build the signed /verify-pass URLs encoded in membership card QR codes.
  PUBLIC_BASE_URL: string;
  // Secret -- real Apple-issued cert/key/WWDR chain, per Phase 0.2/4.6. No
  // wrangler.toml placeholders; pass signing fails without them.
  APPLE_PASS_CERT_PEM: string;
  APPLE_PASS_KEY_PEM: string;
  APPLE_WWDR_CERT_PEM: string;
  // Secret -- HS256 key for the `lv_session` cookie (Phase 2.3.1). Freshly
  // generated, NOT the legacy app's SECRET_KEY. Deliberately not given a
  // placeholder in wrangler.toml `[vars]`: set via `wrangler secret put`
  // (or `.dev.vars` locally). An unset key fails closed -- session
  // middleware throws rather than signing with an empty key.
  SESSION_SIGNING_KEY: string;
  // APNs token auth for Wallet pass-update pushes (Phase 4.7): the Key ID and
  // `.p8` private key of an APNs auth key from the Apple Developer portal.
  // Optional -- pushes are skipped (with a warning) until both are set via
  // `wrangler secret put`; no wrangler.toml placeholders, same convention as
  // SESSION_SIGNING_KEY.
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY_PEM?: string;
  // OAuth login via Auth.js (Phase 2.3.2, src/auth/authjs.ts). AUTH_SECRET
  // encrypts Auth.js's own cookies (required; unset fails closed). Provider
  // credentials are optional -- a provider is only offered once they're set.
  // All secrets, set via `wrangler secret put` with no wrangler.toml
  // placeholders, same convention as SESSION_SIGNING_KEY.
  AUTH_SECRET: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  // Sign in with Apple private key (`.p8`, PKCS#8 PEM) and its key ID.
  APPLE_SIGNIN_KEY_ID?: string;
  APPLE_SIGNIN_PRIVATE_KEY_PEM?: string;
  // Not secret -- Sign in with Apple services ID (the OAuth client_id) and
  // Apple developer team ID; real values in wrangler.toml `[vars]`.
  AUTH_APPLE_ID: string;
  APPLE_SIGNIN_TEAM_ID: string;
  // Secret -- HMAC key for membership card QR-code signatures
  // (src/lib/passSignature.ts). Deliberately the legacy app's key bytes
  // (`SECRET_KEY * 5`), so existing QR codes keep verifying; see
  // docs/legacy-pass-compatibility.md (D2). No wrangler.toml placeholder;
  // unset fails closed.
  PASS_SIGNATURE_KEY: string;
  // Set only while rotating PASS_SIGNATURE_KEY: also accepted at
  // /verify-pass, never used to sign (docs/pass-signature-rotation.md).
  PASS_SIGNATURE_KEY_PREVIOUS?: string;
  // Google Wallet (Phase 5, src/member/artifacts.ts). Issuer ID and class
  // suffix are non-secret vars in wrangler.toml; the service account's
  // `client_email` and `private_key` are secrets (no placeholders) -- the
  // "Save to Google Wallet" link fails closed until both are set.
  GOOGLE_WALLET_ISSUER_ID: string;
  GOOGLE_WALLET_CLASS_SUFFIX: string;
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_WALLET_PRIVATE_KEY_PEM?: string;
  // Email card delivery (src/member/email-card.tsx). SENDGRID_API_KEY and
  // TURNSTILE_SECRET_KEY are secrets, set via `wrangler secret put` with no
  // wrangler.toml placeholders (same convention as SESSION_SIGNING_KEY).
  // TURNSTILE_SITE_KEY isn't secret (it's rendered into the form), so it's a
  // wrangler.toml `[vars]` entry -- one widget per environment, since a widget
  // only answers for its own hostnames. Production's is still empty, awaiting
  // a widget for card.losverd.es. Until all three are set, /email-card fails
  // closed with a "temporarily unavailable" page.
  SENDGRID_API_KEY?: string;
  /**
   * Date (YYYY-MM-DD) from which a completed new order emails the member
   * their card; empty means never (src/email/newOrder.ts).
   */
  CARD_EMAIL_NEW_ORDERS_SINCE?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  // Not secret -- the legacy app's sender and SendGrid ASM unsubscribe group,
  // in wrangler.toml `[vars]`. An empty group ID sends without one.
  /**
   * Who this environment may email (#155). `*` permits anyone, an empty
   * string permits nobody, and anything else is a comma- or space-separated
   * list of addresses and domains. The same value means the same thing in
   * every environment; production carries `*` explicitly.
   */
  EMAIL_RECIPIENT_ALLOWLIST: string;
  EMAIL_FROM_ADDRESS: string;
  EMAIL_FROM_NAME: string;
  SENDGRID_UNSUBSCRIBE_GROUP_ID: string;
  // Secret -- Slack bot token (`xoxb-...`, scopes `users:read` and
  // `users:read.email`) for the Slack members ETL (src/slack/membersEtl.ts).
  // Optional -- the ETL is skipped (with a warning) until it's set via
  // `wrangler secret put`; no wrangler.toml placeholder.
  SLACK_BOT_TOKEN?: string;
  // Secret -- a Slack incoming webhook URL for operational alerts
  // (src/slack/alert.ts). Deliberately separate from SLACK_BOT_TOKEN, which
  // can read every workspace member's email; this grants only "post to one
  // channel". Optional: alerts are skipped (with a warning) until it's set.
  SLACK_ALERT_WEBHOOK_URL?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.route("/bigcommerce", bigcommerce);
// Member login flows (Phase 2.3): /login, /login/complete, and Auth.js at
// /api/auth/* (whose callback URLs are registered with each provider).
app.route("/", auth);
// Registered before the handler it wraps, so it can rewrite where a
// finished OAuth callback sends the browser (see `landOnSessionBridge`).
app.use("/api/auth/callback/*", landOnSessionBridge);
app.use("/api/auth/*", initAuthConfig(authConfig), authHandler());

// Apple PassKit Web Service API (Phase 4). Mounted at `/passkit` to match
// the real `webServiceURL` value discovered in the legacy app's own passes
// ("https://card.losverd.es/passkit") -- Apple appends `/v1/...` to
// whatever `webServiceURL` a pass declares.
app.route("/passkit", passkit);

// Membership card QR-code verification (the legacy `/verify-pass` URL is
// baked into existing cards' QR codes).
app.route("/verify-pass", verifyPass);
app.route("/email-card", emailCard);
// Claiming a membership bought under another address (#144), which is how
// an Apple Hide My Email sign-in reaches its card.
app.route(CLAIM_PATH, claimMembership);
// Public images: Google Wallet fetches a pass logo by URL (src/assets.ts).
app.route("/assets", assets);
// Admin-only membership reports (replaces the legacy Data Studio report).
app.route("/admin/reports", adminReports);
// Admin order page: attribute an order to someone other than its purchaser.
app.route("/admin/orders", adminOrders);
// Admin: correct a member's "member since" date where the orders can't say.
app.route("/admin/member-since", adminMemberSince);
// Admin readiness page: what this environment's deployment is missing.
app.route("/admin/preflight", adminPreflight);
app.route("/", portal);

// Anything a route didn't handle: logged in full, apology page for people.
app.onError(handleServerError);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  queue: handleQueueBatch,
  scheduled,
};
