/**
 * The names of every Worker secret, shared by the tools that reason about
 * them: `worker-secrets.mjs` (which pushes and reports on them) and
 * `secrets-compare.mjs` (which checks the two environments share no values).
 *
 * It lives here rather than in either tool because importing one script from
 * another would run that script's main body as a side effect. One list also
 * means a secret added for one tool cannot be invisible to the other.
 *
 * Import-free, so `.mjs` tools can import it directly under Node's TypeScript
 * type stripping -- the same arrangement as `opItem.ts` alongside it.
 */

/** Every Worker secret the code reads (`Env` in src/index.ts, minus the plain vars in wrangler.toml). */
export const WORKER_SECRETS: string[] = [
  // Login and sessions
  "AUTH_SECRET",
  "SESSION_SIGNING_KEY",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "APPLE_SIGNIN_KEY_ID",
  "APPLE_SIGNIN_PRIVATE_KEY_PEM",
  // BigCommerce
  "BIGCOMMERCE_ACCESS_TOKEN",
  "BIGCOMMERCE_WEBHOOK_SIGNING_KEY",
  // Apple Wallet passes and QR verification
  "APPLE_PASS_CERT_PEM",
  "APPLE_PASS_KEY_PEM",
  "APPLE_WWDR_CERT_PEM",
  "PASS_SIGNATURE_KEY",
  "PASS_SIGNATURE_KEY_PREVIOUS",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY_PEM",
  // Google Wallet
  "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WALLET_PRIVATE_KEY_PEM",
  // Email card delivery
  "SENDGRID_API_KEY",
  "TURNSTILE_SECRET_KEY", // TURNSTILE_SITE_KEY is public: a plain var in wrangler.toml
  // Slack members sync
  "SLACK_BOT_TOKEN",
  "SLACK_ALERT_WEBHOOK_URL",
];
