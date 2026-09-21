# Terraform (Cloudflare resources)

Manages the durable Cloudflare resources this service depends on: the D1 database, R2 bucket, and queues, for both production and staging, each a fully separate set created via `for_each` over `local.environments` (`environments.tf`). The `staging` Worker points at the test BigCommerce store. Worker code deployment itself is handled by Wrangler in `.github/workflows/deploy.yml`, not Terraform -- this mirrors the existing `digital-membership` repo's split between Terraform-managed infrastructure and CI/CD-managed application deploys.

## Setup

Local runs go through the `just tf` wrapper, which shells out via `op run` to pull credentials from 1Password (item `lv-card-losverd-es-github-workflows` in the `Los Verdes` vault) rather than requiring a manual `export` -- see the `justfile` at the repo root for the exact `op://` references. Requires the 1Password CLI (`op`) installed and signed in.

1. `just tf-init`
2. `just tf-plan`
3. `just tf-apply`
4. Copy the `d1_database_ids` output into `wrangler.toml`'s `[[d1_databases]]` block (already done as of 2026-09-16 for the currently-provisioned resources -- only needed again if the D1 database is ever recreated).

(`just tf <args>` is the thin wrapper `tf-init`/`tf-plan`/`tf-apply` all call -- it runs plain `terraform` in CI, where the workflow's own env already supplies credentials directly from GitHub Actions secrets rather than 1Password.)

## API token permissions

`.github/workflows/deploy.yml`'s `CLOUDFLARE_API_TOKEN` secret and this Terraform config's `CLOUDFLARE_API_TOKEN` env var are the same token. As of 2026-09-16, this is a new account-wide token with deliberately broad ("ample") permissions, replacing an earlier, more narrowly-scoped one that was missing `Workers R2 Storage:Edit` (which blocked `terraform apply` on the R2 bucket resource until then).

**This broad scope is intentional for now, not a final state.** Tightening every credential in this project (this token, the R2/S3 remote-state `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair below, and anything else) down to least-privilege is a tracked, must-do-before-considering-this-migration-done task -- see [issue #15](https://github.com/los-verdes/card-losverd-es/issues/15) (and the migration plan's Open Items).

The minimum this token needs, derived from what Terraform and the Deploy workflow actually call:

| Permission group | Needed by |
| --- | --- |
| Account > **D1** > Edit | `cloudflare_d1_database`; `just db-migrate-remote` |
| Account > **Workers R2 Storage** > Edit | `cloudflare_r2_bucket`; `just r2-upload-templates` |
| Account > **Queues** > Edit | `cloudflare_queue`; `wrangler deploy` configuring queue consumers |
| Account > **Workers Scripts** > Edit | `wrangler deploy` |

Zone-level permissions are not needed until the Phase 8 DNS cutover.

`just cloudflare-token-check` checks a token against that list before it is swapped in. It is read-only -- it lists each resource type rather than creating anything -- so it is safe to run against a candidate token at any time, and it names the group to add for anything missing. It proves each group is *granted*; it cannot prove the group is scoped to Edit rather than Read, because only a write does that. Deploy to staging to prove the rest.

It also reports how long each credential has left, and exits non-zero once one has expired -- an expiry is a deploy that breaks on a date nobody is watching, and every permission group can still be listed correctly while it does. The API token's expiry comes back from Cloudflare's own verify endpoint. The state credential's cannot: it is an access key pair rather than a bearer token, so there is nothing to ask, and the date has to be recorded alongside it and passed in as `TF_STATE_TOKEN_EXPIRES_ON`. An unrecorded expiry is reported as unrecorded rather than treated as "does not expire" -- from here those look identical, and only one of them is safe.

## Remote state

State lives in Cloudflare R2, accessed through Terraform's `s3` backend (R2 is S3-API-compatible) -- see `_config.tf`. Credentials are a separate `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair (R2 API tokens, not real AWS credentials -- named that way only because the `s3` backend expects those env var names). The bucket, `los-verdes-terraform-state`, is provisioned ad hoc outside this Terraform config, since Terraform can't very well manage the bucket holding its own state. Supplied via 1Password locally and via GitHub Actions secrets in CI, same pattern as the Cloudflare token above.

In the Los Verdes account this is a dedicated R2 token named **`terraform-state-management`**, scoped to that bucket alone and set to expire annually. Two consequences worth knowing. It is the one credential here no Cloudflare API token grants, so a token that passes `cloudflare-token-check` can still leave `terraform init` unable to read state. And because it expires, the date belongs wherever the key does -- see `TF_STATE_TOKEN_EXPIRES_ON` above, which is how the check reports it.

The endpoint URL in `_config.tf` contains the account id. Moving accounts means changing it, and getting it wrong does not fail loudly: it authenticates against the wrong account.

## DNS

The `card.losverd.es` DNS record is intentionally **not** defined here yet -- that's the actual cutover step (see the migration plan's Phase 8) and shouldn't be something a routine `terraform apply` could trigger by accident.
