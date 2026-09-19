# card-losverd-es

Digital membership card service for the [Los Verdes supporters group](https://www.losverdesatx.org/), serving `card.losverd.es`.

This is the Cloudflare Workers + D1 + R2 rewrite of [`digital-membership`](https://github.com/los-verdes/digital-membership) (Python/Flask on GCP). The two run side by side during the migration: `digital-membership` stays live and authoritative in production until this one is fully built and validated, at which point cutover happens via a DNS repoint (see "Status" below for how close that is). Why that stack was chosen is in [`docs/architecture-decisions.md`](docs/architecture-decisions.md); how the switch happens is in [`docs/cutover.md`](docs/cutover.md).

## Stack

- **Runtime:** [Hono](https://hono.dev/) on Cloudflare Workers (TypeScript)
- **Datastore:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2
- **Async:** Cloudflare Queues and cron triggers
- **Pages:** server-rendered Hono JSX, no client-side framework
- **Infra:** Terraform (`terraform/`) for D1, R2, and queues; Wrangler for Worker deploys

## Development

Requires [Node.js](https://nodejs.org/), [just](https://github.com/casey/just), and a Cloudflare account with Workers/D1/R2 access.

```bash
npm install
just dev             # local dev server (wrangler dev)
just test            # run tests
just test-coverage   # run tests with coverage
just typecheck
just lint
```

Infrastructure changes (Terraform) are a separate concern from app development above — see `terraform/README.md` if you need to touch `terraform/`.

## Infrastructure & deployment

There are two environments, each a separate Worker with its own D1 database, R2 bucket, queues (Terraform-provisioned via `for_each`, see `terraform/README.md`), vars, and secrets:

| Environment | Worker | BigCommerce store | URL |
| :--- | :--- | :--- | :--- |
| **staging** | `card-losverd-es-staging` (`[env.staging]` in `wrangler.toml`) | test store | https://card-losverd-es-staging.jeff-hogan1.workers.dev |
| **production** | `card-losverd-es` (top-level `wrangler.toml`) | production store | https://card-losverd-es.jeff-hogan1.workers.dev (until `card.losverd.es` DNS cutover) |

`.github/workflows/deploy.yml`:

- **Merge to `main`:** `terraform apply`, then staging (D1 migrations, R2 template assets, Worker deploy), then the same for production -- full GitOps, no manual step.
- **Manual "Run workflow" from any branch:** deploys that branch to **staging only**, to try a change against the test store before merging. Terraform is skipped for these runs, so unmerged infrastructure changes never apply.

Secrets are per Worker and pushed from 1Password (see "Secrets" below). Named Wrangler environments don't inherit vars or bindings, so `[env.staging]` spells everything out; `just check-wrangler-envs` (run in CI) fails if its names drift from production's or if it ever points at a production resource.

**Logs:** Workers Logs is on for both environments (`[observability]` in `wrangler.toml`), so console output and uncaught errors are kept for 7 days and searchable in the Cloudflare dashboard under the Worker's **Observability** tab. `npx wrangler tail [--env staging]` still streams them live.

The `card.losverd.es` DNS record is deliberately not managed here yet -- that's the cutover step itself, not something a routine `terraform apply` should be able to trigger.

## Keeping dependencies current

Twenty direct dependencies, and the intent is that keeping them current stays a few minutes a month rather than a standing chore. Dependabot (`.github/dependabot.yml`) does the watching; the design is about keeping the number of pull requests low rather than the number of updates high.

- **One grouped PR a week** for every minor and patch update across all dependencies. Most weeks this is the only one, and reviewing it means reading a changelog rather than a diff.
- **A second grouped PR** for GitHub Actions. Worth keeping current for its own sake: a runner deprecation is announced against action versions, so the way it reaches this repository is an action that has not been bumped.
- **Majors arrive one at a time**, except for TypeScript, ESLint and Vitest, whose majors change how the code is written rather than what it depends on. Those are ignored by Dependabot and done deliberately, so a stale PR isn't sitting open for weeks. Their minor and patch updates still come through the group. As of 2026-09-19 ESLint is on 10; Vitest 5 waits on `@cloudflare/vitest-plugin` (1.1.13 pins `vitest ^4.1.0`) and TypeScript 7 on `typescript-eslint` (8.70 stops at `<6.1`), so re-check those two peer ranges before trying either.
- **Nothing auto-merges.** CI passing is not the same as someone having decided the change is wanted, and these land code nobody has read.

When a bump breaks something, close the PR rather than leaving it open: Dependabot will not re-raise the same version, but it will offer the next one. That is exactly the behaviour wanted for `satori`, which is [pinned at 0.32.0](https://github.com/los-verdes/card-losverd-es/issues/8) because of a Workers runtime incompatibility rather than anything in its API -- a Dependabot PR turns "someone should check whether this is fixed yet" into a CI run that answers it.

Two pairings to keep in mind when reviewing, because the tests will tell you but the changelog won't: `wrangler` and `@cloudflare/vitest-plugin` both carry a workerd, and `@cloudflare/workers-types` should match the `compatibility_date` in `wrangler.toml`.

## What's here

| Path | What it is | Auth |
| :--- | :--- | :--- |
| `/` , `/card.png`, `/passes/apple.pkpass`, `/passes/google` | Member portal: your card, card image, and wallet passes (`src/member/portal.tsx`) | Logged-in current member |
| `/login`, `/logout`, `/api/auth/*` | Login with Google or Apple via Auth.js, bridged to a signed `lv_session` cookie. `/login` also offers `/email-card`, for anyone who has neither account (`src/auth/`) | Public |
| `/email-card` | No-login fallback: emails a member their card. Turnstile-protected and rate limited; never reveals whether an address is a member (`src/member/email-card.tsx`) | Public |
| `/verify-pass` | What a card's QR code points at; shows the holder's current membership (`src/member/verify-pass.tsx`) | Any logged-in user |
| `/passkit/v1/*` | Apple PassKit web service: device registration, pass delivery, update polling, device logs (`src/passkit/`) | Per-pass auth token |
| `/bigcommerce/order-webhook` | BigCommerce order webhook; validates, then queues the sync (`src/bigcommerce/routes.ts`) | Signed bearer token |
| `/admin/reports/*` | Membership reports with CSV export (`src/admin/`), see [`docs/reporting.md`](docs/reporting.md) | Admin |
| `/admin/orders/:id` | One membership order; attribute it to someone other than its purchaser, with an audit trail (`src/admin/orders.tsx`) | Admin |
| `/admin/member-since` | Correct a member's "member since" date when their orders don't show when they really joined (`src/admin/memberSince.tsx`) | Admin |
| `/admin/preflight` | Whether this environment is ready: credentials, storage, integrations, and the steps still needing a person (`src/admin/preflight.tsx`) | Admin |
| `/assets/:name` | Public images, allow-listed; Google Wallet fetches the pass logo from here (`src/assets.ts`) | Public |
| `/healthz` | Liveness check | Public |

Behind the routes:

- **`etl-sync` queue** (`src/queues/`): one consumer at a time, five retries, then a dead-letter queue, whose consumer posts one Slack alert per batch. `just queue-dlq-drill [env]` proves that path in a real environment by sending a `dlq_drill` message, which fails on purpose. It takes about thirteen minutes, nearly all retry backoff, and proves the whole chain including the dead-letter binding; `--direct` posts straight to the dead-letter queue instead, answering "does the alert still reach Slack" in seconds while proving nothing about how a message gets there. Carries BigCommerce order syncs and the scheduled jobs below.
- **Scheduled jobs** (`src/scheduled.ts`): BigCommerce order resync, the Slack members sync, and a weekly readiness check that runs the `/admin/preflight` checks and posts to Slack **only when one has failed** (`src/admin/readinessAlert.ts`) -- so a pass certificate nearing expiry is noticed without anyone opening the page. **Staging runs the resync every six hours** (`[env.staging.triggers]` in `wrangler.toml`) against the sandbox store; the Slack sync waits on staging having its own Slack app ([#133](https://github.com/los-verdes/card-losverd-es/issues/133)). **Production has no triggers yet**, until its BigCommerce credentials are in place.
- **Apple pass updates** (`src/passkit/apns.ts`, `updates.ts`): when a sync changes something visible on a pass, registered devices get an APNs push.
- **Who we may email** (`EMAIL_RECIPIENT_ALLOWLIST`, a plain var): `*` permits any address, an empty value permits none, and anything else is a comma- or space-separated list of addresses and domains. It means the same thing in every environment -- production carries `*` explicitly, so an environment that loses the var goes quiet rather than open. Enforced in `sendEmail`, which every outbound message passes through; a suppressed send is logged and never throws. Staging is limited to `losverd.es`, which is what makes realistic member data safe to hold there.
- **New-order card emails** (`src/email/newOrder.ts`): when an order webhook reports an order has reached `Completed`, the member is emailed their card, once. **Off until `CARD_EMAIL_NEW_ORDERS_SINCE` is set** to a date -- see [`docs/bigcommerce-ingestion.md`](docs/bigcommerce-ingestion.md).

## Data (D1)

Schema lives in `src/db/migrations/` (applied automatically on deploy); `src/db/schema.sql` mirrors it for reading.

| Table | Holds |
| :--- | :--- |
| `members` | Each member's **current** state; what passes and cards render from. Written by the BigCommerce sync. |
| `membership_orders` | **Every** membership order ever, one row each, including Squarespace-era orders imported from the legacy database. What reporting runs on, and what cards are derived from (by `member_email`). |
| `membership_order_attributions` | Audit trail of admins attributing orders to someone other than their purchaser. |
| `member_since_overrides` | "Member since" dates that win over the order-derived one: legacy imports and manual corrections. |
| `legacy_membership_cards` | Legacy card serials, so QR codes printed before the migration still verify. |
| `slack_users` | Copy of the Slack workspace's user list, for cross-referencing members against Slack. |
| `users`, `oauth_identities` | Login identities. `users.is_admin` gates `/admin`. |
| `devices`, `registrations`, `pass_device_logs` | Apple PassKit device state. |
| `etl_sync_state`, `rate_limit_counters` | Sync watermarks; rate limiting for `/email-card`. |
| `card_emails` | One row per order already emailed a card, written before sending so a retry can't send twice. |

## Secrets

**1Password is the source of truth**, because Cloudflare never returns a secret's value: anything kept only in Cloudflare can't be recovered. Each environment has one item in the "Los Verdes" vault, `lv-card-losverd-es-worker-staging` / `lv-card-losverd-es-worker-production`, with one field per secret labeled with its exact name. Then:

```bash
just secrets-status staging              # what 1Password and Cloudflare each have (names, lengths, line counts; never values)
just secrets-push staging                # push every secret the item has a value for, in one deploy
just secrets-push staging AUTH_SECRET    # push only the named ones, e.g. after rotating
```

Use a different value per environment. Random values (`openssl rand -hex 32`) work for `AUTH_SECRET`, `SESSION_SIGNING_KEY`, `BIGCOMMERCE_WEBHOOK_SIGNING_KEY`, and staging's `PASS_SIGNATURE_KEY`. Check `secrets-status` line counts after pasting a PEM: it should span several lines. None have placeholders in `wrangler.toml`; features that need a missing secret fail closed or skip themselves with a logged warning.

Some secrets can't just be regenerated: changing production's `PASS_SIGNATURE_KEY` would break every QR code already issued, so it rotates through an overlap window ([`docs/pass-signature-rotation.md`](docs/pass-signature-rotation.md)), and changing `BIGCOMMERCE_WEBHOOK_SIGNING_KEY` means re-registering the store's webhook, whose header carries a token derived from it.

| Secret | Needed for |
| :--- | :--- |
| `SESSION_SIGNING_KEY`, `AUTH_SECRET` | Any login at all |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Login with Google |
| `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY_PEM` | Sign in with Apple |
| `BIGCOMMERCE_ACCESS_TOKEN`, `BIGCOMMERCE_WEBHOOK_SIGNING_KEY` | Order sync and webhook verification |
| `APPLE_PASS_CERT_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_WWDR_CERT_PEM` | Signing Apple Wallet passes |
| `APNS_KEY_ID`, `APNS_PRIVATE_KEY_PEM` | Pushing Apple pass updates |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_WALLET_PRIVATE_KEY_PEM` | "Save to Google Wallet" links |
| `PASS_SIGNATURE_KEY` | Card QR code signatures; deliberately the legacy key, see [`docs/legacy-pass-compatibility.md`](docs/legacy-pass-compatibility.md) |
| `SENDGRID_API_KEY`, `TURNSTILE_SECRET_KEY` | `/email-card` (also needs the non-secret `TURNSTILE_SITE_KEY` var) |
| `SLACK_BOT_TOKEN` | Slack members sync; scopes `users:read` and `users:read.email` |
| `SLACK_ALERT_WEBHOOK_URL` | Dead-letter alerts; an incoming webhook, deliberately not the bot token above. Optional: alerts are skipped until it's set |

For the `*_PEM` secrets, paste the file's own text. 1Password's password fields strip the line breaks, which is harmless -- both parsers used here (`node-forge` for pass signing, `jose` for JWT keys) discard whitespace before decoding the base64. A value carrying literal `\n` escapes, as copied out of a Google service-account JSON file, is *not* harmless: it fails at runtime with an opaque ASN.1 error, so `secrets-push` refuses it (along with a value that isn't PEM at all, one that's truncated, and a passphrase-protected key, which `node-forge` can't read).

### Creating the Google Wallet class

A "Save to Google Wallet" link only works if the pass class it names already
exists on Google's side; the Worker signs the pass object, not the class.
Create it once per environment (and again if it changes):

```bash
just google-wallet-ensure-class staging --dry-run
just google-wallet-ensure-class staging
```

It reads the service account credentials from the environment's 1Password
item and the issuer id and class suffix from `wrangler.toml`. Each
environment has its own class, so staging can't alter the one production
passes are filed under -- `just check-wrangler-envs` fails if they ever
match. Issuer accounts also start in demo mode, where only test accounts can
save a pass; production access is granted in the Google Pay & Wallet Console.

When a save link fails, the member sees only "Something went wrong. Please try
again." -- the same message whether the class is missing, the service account
has no issuer access, the Wallet API is not enabled in its GCP project, the
object is missing a required field, or the issuer is still in demo mode. The
JWT is validated inside Google, so there is nothing to tail. To tell those
apart:

```bash
just google-wallet-check staging              # read-only
just google-wallet-check staging --insert     # have Google validate the object itself
just google-wallet-check staging --object LV-... # look up one member's saved pass
```

It builds the object with the Worker's own builder, so what it checks is what
members get. `--insert` is the authoritative check and the only way to get a
specific error out of Google, but it writes one synthetic object to the issuer
account, which cannot afterwards be deleted -- inert, since nobody holds it.

### Renewing the Apple pass certificate

Apple issues a Pass Type ID certificate for one year. When it lapses, signing
new `.pkpass` bundles stops working -- passes already installed keep working,
but nobody new can add one. Two of the ways to get this wrong produce a pass
that iOS refuses to add with no explanation whatsoever: a private key that does
not match the certificate, and a WWDR intermediate from a different generation
than the one that signed it. So the tooling checks both rather than trusting
the process.

Start by generating a key and a signing request:

```bash
just apple-pass-cert-csr
```

That prints the one step that cannot be automated -- Apple's console has no API
for these certificates, so the request has to be uploaded by hand and the `.cer`
downloaded. **Renew against the existing pass type identifier**; a new one would
orphan every pass already in a member's wallet.

Then hand the download back:

```bash
just apple-pass-cert-install staging ~/Downloads/pass.cer
```

which refuses to go on unless the certificate is for this project's pass type
and team, matches the key that requested it, and verifies against the WWDR
intermediate it names. If all three hold, it stores the certificate, key and
intermediate in the environment's 1Password item, reads them back to confirm,
pushes them to the Worker, and deletes the local copies -- the private key is
on disk only in between, under `.apple-pass-cert/` (gitignored).

To see what an environment currently has, and how long is left on it:

```bash
just apple-pass-cert-check staging
```

### Registering the BigCommerce order webhook

BigCommerce doesn't sign webhooks, so each store's `store/order/*` webhook is registered with an `Authorization: bearer <token>` header the Worker recomputes from `BIGCOMMERCE_WEBHOOK_SIGNING_KEY`, the store hash, and `BIGCOMMERCE_CLIENT_ID`. Create or update it (and again after rotating the key) with:

```bash
just bigcommerce-ensure-webhook staging --dry-run   # show what would change
just bigcommerce-ensure-webhook staging
```

It reads the access token and signing key from the environment's 1Password item and the store and client ids from `wrangler.toml` (refusing a placeholder client id). Production's default destination, `card.losverd.es`, is where the **legacy** app's webhook lives until cutover, so it's refused without `--cutover`; to test production before then, pass `--origin https://card-losverd-es.jeff-hogan1.workers.dev`.

## Making someone an admin

Admin is a flag in D1, checked on every admin request. The person logs in once so their `users` row exists, then:

```bash
npx wrangler d1 execute DB --remote --env="" --command \
  "UPDATE users SET is_admin = 1 WHERE email = 'someone@example.com'"
```

`--env=""` is production; use `--env staging` for staging. Set it back to `0` to revoke; it takes effect immediately.

Worth doing early on a new environment rather than last: the readiness page below is admin-gated, and it is most useful while an environment is still being set up.

## Checking whether an environment is ready

`/admin/preflight` reports what the deployed Worker can see of its own environment: whether `PUBLIC_BASE_URL` matches the host serving it, whether the D1 migrations ran and the R2 template images are uploaded, whether the Apple pass certificate matches its key and its bundled WWDR intermediate and how long it has left, whether the Google Wallet class exists, whether BigCommerce accepts the access token and has an order webhook pointing here carrying the token this Worker verifies, and which of the optional integrations are configured.

It exists because the problems worth finding are invisible from outside. A private key stored with literal `\n` escapes, a template image never uploaded, a Wallet class that was never created — each shows up only as a generic error page, or the provider's own generic failure, some time after the deploy that caused it. The code that can tell the difference is the code that parses the credential, which runs in the Worker.

Two properties it keeps: it never reports a secret's value (presence, shape, expiry and already-public identifiers only), and it never writes anything — a check that created the Wallet class it was looking for would report success for a state it had just manufactured.

The steps no code can take — installing a pass on a real iPhone, saving one on Android, comparing the admin reports against the legacy report — are listed on the same page, so there is one list to work down instead of a separate runbook to keep current.

## Status

Feature-complete enough to exercise end to end on staging; **not yet cut over**. `digital-membership` on GCP is still production. What remains, in order, is [`docs/cutover.md`](docs/cutover.md); what is blocked and on what is the [issue tracker](https://github.com/los-verdes/card-losverd-es/issues).

Deliberately dropped from the legacy app: Squarespace integration, Yahoo login, BigCommerce storefront SSO, the provider-disconnect flow, and migrating installed legacy passes (members get a fresh pass).

After cutover: MiniBC renewal data, membership revocation ([#31](https://github.com/los-verdes/card-losverd-es/issues/31)), and a look at Workers' built-in deployment and observability ([#56](https://github.com/los-verdes/card-losverd-es/issues/56)).

## More docs

- [`docs/migration-plan.md`](docs/migration-plan.md): the phase index the code's `Phase N` comments refer to, and where each phase's detail lives now
- [`docs/architecture-decisions.md`](docs/architecture-decisions.md): why Cloudflare, why TypeScript, why one DNS cutover, and the non-profit context those rest on
- [`docs/cutover.md`](docs/cutover.md): the ordered runbook for moving `card.losverd.es` and retiring GCP
- [`docs/membership-card-provenance.md`](docs/membership-card-provenance.md): where each card field comes from and how "current member" is decided, written for the membership committee
- [`docs/reporting.md`](docs/reporting.md): admin reports, the order history behind them, and the Slack sync
- [`docs/bigcommerce-ingestion.md`](docs/bigcommerce-ingestion.md): webhook verification, the order-to-member mapping, scheduled resync
- [`docs/legacy-pass-compatibility.md`](docs/legacy-pass-compatibility.md): what carries over from legacy passes and QR codes, and what doesn't
- [`scripts/legacy-export/README.md`](scripts/legacy-export/README.md): the one-time legacy database export runbook
- [`terraform/README.md`](terraform/README.md): infrastructure, remote state, API token scope
- [`CLAUDE.md`](CLAUDE.md): how to work in this repository -- bot attribution on pushes, the no-bulk-email rule, no real personal data, warning triage, and the sharp edges
