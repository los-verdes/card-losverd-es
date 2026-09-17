resource "cloudflare_r2_bucket" "assets" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  name       = "card-losverd-es${each.value.name_suffix}-assets"
}

moved {
  from = cloudflare_r2_bucket.assets
  to   = cloudflare_r2_bucket.assets["production"]
}
