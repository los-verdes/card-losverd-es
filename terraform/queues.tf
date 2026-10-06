# Cloudflare Queues for async/background work.
# Requires the Workers Paid plan. Only the queues themselves live here;
# producer/consumer bindings are declared in wrangler.toml and managed by
# `wrangler deploy`, alongside the Worker code that uses them. The Deploy
# workflow runs `terraform apply` before `wrangler deploy`, so these exist
# before the Worker config references them.
#
# A `member-actions` queue was planned and retired before it was built: card
# images render on request, so there is nothing to fan out.
#
# Unlike the D1 database and R2 bucket, these have no `prevent_destroy`:
# they hold only in-flight messages, and renames update in place.

resource "cloudflare_queue" "etl_sync" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  queue_name = "etl-sync-${each.key}"
}

# Messages that exhaust etl-sync's retries land here instead of being
# silently dropped.
resource "cloudflare_queue" "etl_sync_dlq" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  queue_name = "etl-sync-dlq-${each.key}"
}
