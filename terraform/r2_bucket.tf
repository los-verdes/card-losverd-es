resource "cloudflare_r2_bucket" "assets" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-assets-${each.key}"
}


# TODO: remove this after TF has been applied
moved {
  from = cloudflare_r2_bucket.assets
  to   = cloudflare_r2_bucket.assets["production"]
}
