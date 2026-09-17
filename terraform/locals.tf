# Deployment environments. Each gets a fully separate set of durable resources
# (D1, R2, queues) via `for_each`: queues can't be shared (one consumer per
# queue), and staging data must never mix with real member data. The staging
# Worker (`[env.staging]` in wrangler.toml) points at the test BigCommerce
# store.
#
# Recorded as a value-less map for the moment; this works with `for_each` and gives
# us a location to implement env-specific overrides down the line if needed.
locals {
  environments = {
    production = {}
    staging    = {}
  }
}
