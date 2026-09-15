variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns these resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment name (e.g. preview, production)."
  type        = string
  default     = "production"
}
