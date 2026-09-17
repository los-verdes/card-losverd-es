output "d1_database_ids" {
  description = "D1 database ID per environment -- copy into wrangler.toml's [[d1_databases]] (production) / [[env.staging.d1_databases]] (staging) database_id fields."
  value       = { for env, db in cloudflare_d1_database.membership : env => db.id }
}

output "r2_bucket_names" {
  description = "R2 bucket name per environment -- matches wrangler.toml's r2_buckets bucket_name fields."
  value       = { for env, bucket in cloudflare_r2_bucket.assets : env => bucket.name }
}
