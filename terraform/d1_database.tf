resource "cloudflare_d1_database" "membership" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-db-${each.key}"

  read_replication = {
    mode = "disabled"
  }
}

# Production's database predates `for_each`; re-address it in place rather than
# recreating it (which would change the database_id wrangler.toml pins).
# TODO: remove this after it has been applied
moved {
  from = cloudflare_d1_database.membership
  to   = cloudflare_d1_database.membership["production"]
}
