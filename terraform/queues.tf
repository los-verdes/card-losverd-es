# Cloudflare Queues for async/background work (migration plan Phase 2.5).
# Requires the Workers Paid plan. Only the queues themselves live here;
# producer/consumer bindings are declared in wrangler.toml and managed by
# `wrangler deploy`, alongside the Worker code that uses them. The Deploy
# workflow runs `terraform apply` before `wrangler deploy`, so these exist
# before the Worker config references them.
#
# `member-actions` (Phase 2.5.1) isn't provisioned yet -- nothing produces
# to it until the card-image backfill is built.

resource "cloudflare_queue" "etl_sync" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  queue_name = "etl-sync${each.value.name_suffix}"
}

# Messages that exhaust etl-sync's retries land here instead of being
# silently dropped.
resource "cloudflare_queue" "etl_sync_dlq" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  queue_name = "etl-sync${each.value.name_suffix}-dlq"
}

moved {
  from = cloudflare_queue.etl_sync
  to   = cloudflare_queue.etl_sync["production"]
}

moved {
  from = cloudflare_queue.etl_sync_dlq
  to   = cloudflare_queue.etl_sync_dlq["production"]
}
