resource "cloudflare_r2_bucket" "assets" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-assets-${each.key}"

  # Same guard as the D1 database: a forced replacement must be a deliberate,
  # separate change, not a side effect of an auto-approved Deploy.
  lifecycle {
    prevent_destroy = true
  }
}
