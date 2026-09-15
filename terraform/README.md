# Terraform (Cloudflare resources)

Manages the durable Cloudflare resources this service depends on: the D1 database and the R2 bucket. Worker code deployment itself is handled by Wrangler in `.github/workflows/deploy.yml`, not Terraform -- this mirrors the existing `digital-membership` repo's split between Terraform-managed infrastructure and CI/CD-managed application deploys.

## Setup

1. `export CLOUDFLARE_API_TOKEN=...` (a token scoped to D1 + R2 admin on the target account).
2. `just tf-init`
3. `just tf-plan <your account id>`
4. `just tf-apply <your account id>`
5. Copy the `d1_database_id` output into `wrangler.toml`'s `[[d1_databases]]` block.

(The `just tf-*` recipes are thin wrappers around `terraform init`/`plan`/`apply` run from `terraform/` -- see the `justfile` at the repo root.)

## API token permissions

The current token ("Los Verdes - card-verd-es - GitHub & Terraform API token") is shared between this Terraform config and `.github/workflows/deploy.yml`'s `CLOUDFLARE_API_TOKEN` secret. As provisioned (2026-09-14, expires **2027-09-17 -- renew before then**; see the Google Calendar reminder set for 2027-09-01), it has:

* Scope: **All accounts** (not narrowed to the single Los Verdes account -- broader than least-privilege; worth tightening once things stabilize).
* Permissions: `Account Settings:Read`, `D1:Edit`, `Workers Scripts:Edit`.

**Known gap:** it does *not* include `Workers R2 Storage:Edit`, which `r2_bucket.tf`'s `cloudflare_r2_bucket` resource needs to create/manage the R2 bucket -- a `terraform apply` that touches the R2 resource will fail permission checks until that's added to the token. Also missing (not needed yet, but will be at Phase 8 cutover): `Zone > Workers Routes:Edit` scoped to the `losverd.es` zone, for wiring up the `card.losverd.es` custom domain/route. See the migration plan's Execution Status section for the standing TODO on sorting these out.

## Remote state

State is currently local-only (no backend configured). Worth deciding on a remote backend (Terraform Cloud, an R2-backed S3-compatible backend, or reusing the existing GCS backend from `digital-membership`) before this goes further than solo experimentation -- flagged here rather than decided, since it's a call worth making deliberately.

## DNS

The `card.losverd.es` DNS record is intentionally **not** defined here yet -- that's the actual cutover step (see the migration plan's Phase 8) and shouldn't be something a routine `terraform apply` could trigger by accident.
