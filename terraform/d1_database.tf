resource "cloudflare_d1_database" "membership" {
  for_each = local.environments

  account_id = var.cloudflare_account_id
  name       = "card-losverd-es-db-${each.key}"

  read_replication = {
    mode = "disabled"
  }

  # Deploy runs `terraform apply -auto-approve`, so a change that forces
  # replacement (e.g. a rename) would otherwise destroy the database and its
  # data, and change the database_id wrangler.toml pins. Remove this
  # deliberately, in its own PR, if a database really must be replaced.
  lifecycle {
    prevent_destroy = true
  }
}
