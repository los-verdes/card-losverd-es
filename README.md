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

The D1 database and R2 bucket are real, Terraform-provisioned Cloudflare resources (see `terraform/README.md`). `.github/workflows/deploy.yml` runs on every push to `main`: `terraform apply`, then D1 migrations, then a Worker deploy — full GitOps, no manual deploy step. The `card.losverd.es` DNS record is deliberately not managed here yet — that's the cutover step itself, not something a routine `terraform apply` should be able to trigger. Until cutover, the live Worker is reachable at its `*.workers.dev` URL, not the real domain.

## Status

Actively being built out, not yet cut over. On `main`:

- BigCommerce order ingestion (webhook + scheduled resync) keeping D1's `members` table in sync
- Apple Wallet passes: signing, `pass.json` content generation, and the full PassKit web service (device registration, pass delivery, unregistration, device error logging)
- Google Wallet "Save to Wallet" JWT generation
- CI/CD: typecheck/lint/test-coverage gate on every PR, Terraform + D1 migrations + Worker deploy run automatically on merge to `main`

Card image generation (Satori + resvg) is built and under review, not yet merged.

Not yet started: member authentication (OAuth/session handling), the member web portal, wiring the `etl-sync` Cloudflare Queue for real (the consumer/scheduler code exists but the queue itself isn't provisioned/bound yet), wiring real Apple/Google/BigCommerce production credentials (currently placeholder secrets), and the actual cutover itself.
