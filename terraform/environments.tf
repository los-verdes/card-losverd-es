# Deployment environments. Each gets a fully separate set of durable resources
# (D1, R2, queues) via `for_each`: queues can't be shared (one consumer per
# queue), and staging data must never mix with real member data. The staging
# Worker (`[env.staging]` in wrangler.toml) points at the test BigCommerce
# store.
#
# `name_suffix` is inserted into every resource name, so production keeps the
# names it already has (e.g. `card-losverd-es-db`) and staging's are
# `card-losverd-es-staging-db`, `etl-sync-staging`, etc.
locals {
  environments = {
    production = { name_suffix = "" }
    staging    = { name_suffix = "-staging" }
  }
}
