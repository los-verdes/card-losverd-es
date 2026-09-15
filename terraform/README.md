# Terraform (Cloudflare resources)

Manages the durable Cloudflare resources this service depends on: the D1 database and the R2 bucket. Worker code deployment itself is handled by Wrangler in `.github/workflows/deploy.yml`, not Terraform -- this mirrors the existing `digital-membership` repo's split between Terraform-managed infrastructure and CI/CD-managed application deploys.

## Setup

1. `export CLOUDFLARE_API_TOKEN=...` (a token scoped to D1 + R2 admin on the target account).
2. `terraform init`
3. `terraform plan -var="cloudflare_account_id=<your account id>"`
4. `terraform apply -var="cloudflare_account_id=<your account id>"`
5. Copy the `d1_database_id` output into `wrangler.toml`'s `[[d1_databases]]` block.

## Remote state

State is currently local-only (no backend configured). Worth deciding on a remote backend (Terraform Cloud, an R2-backed S3-compatible backend, or reusing the existing GCS backend from `digital-membership`) before this goes further than solo experimentation -- flagged here rather than decided, since it's a call worth making deliberately.

## DNS

The `card.losverd.es` DNS record is intentionally **not** defined here yet -- that's the actual cutover step (see the migration plan's Phase 8) and shouldn't be something a routine `terraform apply` could trigger by accident.
