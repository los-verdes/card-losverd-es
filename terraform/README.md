# Terraform (Cloudflare resources)

Manages the durable Cloudflare resources this service depends on: the D1 database and the R2 bucket. Worker code deployment itself is handled by Wrangler in `.github/workflows/deploy.yml`, not Terraform -- this mirrors the existing `digital-membership` repo's split between Terraform-managed infrastructure and CI/CD-managed application deploys.

## Setup

Local runs go through the `just tf` wrapper, which shells out via `op run` to pull credentials from 1Password (item `lv-card-losverd-es-github-workflows` in the `Los Verdes` vault) rather than requiring a manual `export` -- see the `justfile` at the repo root for the exact `op://` references. Requires the 1Password CLI (`op`) installed and signed in.

1. `just tf-init`
2. `just tf-plan`
3. `just tf-apply`
4. Copy the `d1_database_id` output into `wrangler.toml`'s `[[d1_databases]]` block (already done as of 2026-09-16 for the currently-provisioned resources -- only needed again if the D1 database is ever recreated).

(`just tf <args>` is the thin wrapper `tf-init`/`tf-plan`/`tf-apply` all call -- it runs plain `terraform` in CI, where the workflow's own env already supplies credentials directly from GitHub Actions secrets rather than 1Password.)

## API token permissions

`.github/workflows/deploy.yml`'s `CLOUDFLARE_API_TOKEN` secret and this Terraform config's `CLOUDFLARE_API_TOKEN` env var are the same token. As of 2026-09-16, this is a new account-wide token with deliberately broad ("ample") permissions, replacing an earlier, more narrowly-scoped one that was missing `Workers R2 Storage:Edit` (which blocked `terraform apply` on the R2 bucket resource until then).

**This broad scope is intentional for now, not a final state.** Tightening every credential in this project (this token, the R2/S3 remote-state `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair below, and anything else) down to least-privilege is a tracked, must-do-before-considering-this-migration-done task -- see [issue #15](https://github.com/los-verdes/card-losverd-es/issues/15) (and the migration plan's Open Items).

## Remote state

State lives in Cloudflare R2, accessed through Terraform's `s3` backend (R2 is S3-API-compatible) -- see `_config.tf`. Credentials are a separate `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair (R2 API tokens, not real AWS credentials -- named that way only because the `s3` backend expects those env var names), scoped to just the state bucket (`los-verdes-terraform-state`, provisioned ad hoc outside this Terraform config, since Terraform can't very well manage the bucket holding its own state). Supplied via 1Password locally and via GitHub Actions secrets in CI, same pattern as the Cloudflare token above.

## DNS

The `card.losverd.es` DNS record is intentionally **not** defined here yet -- that's the actual cutover step (see the migration plan's Phase 8) and shouldn't be something a routine `terraform apply` could trigger by accident.
