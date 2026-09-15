output "d1_database_id" {
  description = "D1 database ID -- copy into wrangler.toml's [[d1_databases]] database_id field."
  value       = cloudflare_d1_database.membership.id
}

output "r2_bucket_name" {
  description = "R2 bucket name -- matches wrangler.toml's [[r2_buckets]] bucket_name field."
  value       = cloudflare_r2_bucket.assets.name
}
