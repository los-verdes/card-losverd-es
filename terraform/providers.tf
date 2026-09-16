terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.20.0, < 6.0.0"
    }
  }
}

provider "cloudflare" {
  # Authenticates via the CLOUDFLARE_API_TOKEN environment variable.
}
