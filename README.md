# card-losverd-es

Digital membership card service for the [Los Verdes supporters group](https://www.losverdesatx.org/), serving `card.losverd.es`.

This is the Cloudflare Workers + D1 + R2 rewrite of [`digital-membership`](https://github.com/los-verdes/digital-membership) (Python/Flask on GCP). The two run side by side during the migration: `digital-membership` stays live and authoritative in production until this one is fully built and validated, at which point cutover happens via a DNS repoint (see "Status" below for how close that is). The full phase-by-phase migration plan is tracked separately, not in this repo.

## Stack

- **Runtime:** [Hono](https://hono.dev/) on Cloudflare Workers (TypeScript)
- **Datastore:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2
- **Infra:** Terraform (`terraform/`) for D1/R2, Wrangler for Worker deploys

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

Secrets are per Worker: `wrangler secret put NAME` for production, `wrangler secret put NAME --env staging` for staging. Named Wrangler environments don't inherit vars or bindings, so `[env.staging]` spells everything out; `just check-wrangler-envs` (run in CI) fails if its names drift from production's or if it ever points at a production resource.

The `card.losverd.es` DNS record is deliberately not managed here yet -- that's the cutover step itself, not something a routine `terraform apply` should be able to trigger.

## Status

Actively being built out, not yet cut over. On `main`:

- BigCommerce order ingestion (webhook + scheduled resync) keeping D1's `members` table in sync
- Apple Wallet passes: signing, `pass.json` content generation, and the full PassKit web service (device registration, pass delivery, unregistration, device error logging)
- Google Wallet "Save to Wallet" JWT generation
- CI/CD: typecheck/lint/test-coverage/environment-parity gate on every PR; Terraform, then staging, then production deploy automatically on merge to `main`; any branch can be deployed to staging on demand

Card image generation (Satori + resvg) is built and under review, not yet merged.

Not yet started: member authentication (OAuth/session handling), the member web portal, wiring the `etl-sync` Cloudflare Queue for real (the consumer/scheduler code exists but the queue itself isn't provisioned/bound yet), wiring real Apple/Google/BigCommerce production credentials (currently placeholder secrets), and the actual cutover itself.
