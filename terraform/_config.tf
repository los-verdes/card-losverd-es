terraform {
  backend "s3" {
    bucket                      = "los-verdes-terraform-state"
    key                         = "card-losverd-es/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
    endpoints                   = { s3 = "https://42988f13a6daf00814bced22aff46f4e.r2.cloudflarestorage.com" }

    # values supplied via env vars:
    # access_key                  = var.r2_access_key
    # secret_key                  = var.r2_secret_key
  }
}
