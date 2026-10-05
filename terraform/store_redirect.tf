# `store.losverd.es` as a short address for the store: every request on it
# redirects to `store.losverdesatx.org`, path and query kept, so
# `store.losverd.es/membership/` lands on the membership page (#482).
#
# Done in the zone rather than the Worker, so the card site carries nothing
# for a hostname that isn't its own. A 302 rather than a 301, so the
# destination can change later without browsers having cached the old one.
#
# The token this runs with needs Zone > DNS > Edit and Zone > Single Redirect
# > Edit on `losverd.es` for these two (terraform/README.md).

locals {
  # `losverd.es`, pinned rather than looked up, which would need Zone > Zone
  # > Read as well. Not a secret: it is in every DNS API URL for the zone.
  losverd_es_zone_id = "cfca911256d6cf6240686a6f7f8dc74c"
}

# A redirect-only hostname still needs a proxied record for requests to reach
# Cloudflare at all. `100::` is the documented discard address for exactly
# this: the redirect answers before any origin would be asked.
resource "cloudflare_dns_record" "store_losverd_es" {
  zone_id = local.losverd_es_zone_id
  name    = "store.losverd.es"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Redirect-only: see the store redirect rule (card-losverd-es terraform/store_redirect.tf)"
}

# The zone's one ruleset for the dynamic-redirect phase (Redirect Rules in the
# dashboard). A rule added there by hand would be removed by the next apply,
# so further redirects belong in this list.
resource "cloudflare_ruleset" "losverd_es_redirects" {
  zone_id     = local.losverd_es_zone_id
  name        = "Redirect rules"
  description = "Managed by card-losverd-es terraform/store_redirect.tf"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      ref         = "store_losverd_es"
      description = "store.losverd.es to the store"
      expression  = "(http.host eq \"store.losverd.es\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 302
          target_url = {
            expression = "concat(\"https://store.losverdesatx.org\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
    },
  ]
}
