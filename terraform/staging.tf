# Staging environment resources: a fully separate copy of production's durable
# resources for the `staging` Worker (`[env.staging]` in wrangler.toml), which
# points at the test BigCommerce store. Nothing is shared with production --
# queues can't be (one consumer per queue), and staging data must never mix
# with real member data.
#
# Deliberately explicit resources rather than `for_each` over the production
# ones: converting those would change their Terraform addresses, and a missed
# `moved` block would plan to destroy and recreate the production D1 database.

resource "cloudflare_d1_database" "membership_staging" {
  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-staging-db"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "assets_staging" {
  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-staging-assets"
}

resource "cloudflare_queue" "etl_sync_staging" {
  account_id = var.cloudflare_account_id
  queue_name = "etl-sync-staging"
}

resource "cloudflare_queue" "etl_sync_staging_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = "etl-sync-staging-dlq"
}
