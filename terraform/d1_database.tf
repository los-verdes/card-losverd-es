resource "cloudflare_d1_database" "membership" {
  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-db"
}
