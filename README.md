# card-losverd-es

Digital membership card service for the [Los Verdes supporters group](https://www.losverdesatx.org/), serving `card.losverd.es`.

This is the Cloudflare Workers + D1 + R2 rewrite of [`digital-membership`](https://github.com/los-verdes/digital-membership) (Python/Flask on GCP). The two run side by side during the migration: `digital-membership` stays live and authoritative in production until this one is fully built and validated, at which point cutover happens via a DNS repoint. See that repo's `.ai/gcp-to-cf_plan.md` for the full migration plan.

## Stack

- **Runtime:** [Hono](https://hono.dev/) on Cloudflare Workers (TypeScript)
- **Datastore:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2
- **Infra:** Terraform (`terraform/`) for D1/R2, Wrangler for Worker deploys

## Development

Requires [Node.js](https://nodejs.org/), [just](https://github.com/casey/just), and a Cloudflare account with Workers/D1/R2 access.

```bash
npm install
just dev             # local dev server (wrangler dev)
just test            # run tests
just test-coverage   # run tests with coverage
just typecheck
just lint
```

> **Note:** dependency versions in `package.json` were hand-authored (this environment didn't have npm registry access at scaffold time). Run `npm install` and check for peer-dependency warnings — particularly between `vitest` and `@cloudflare/vitest-pool-workers`, which are version-sensitive — before relying on the generated lockfile.

## Infrastructure

See `terraform/README.md` for provisioning the D1 database and R2 bucket. The `card.losverd.es` DNS record is deliberately not managed here yet — that's the cutover step itself (Phase 8 of the migration plan), not something a routine `terraform apply` should be able to trigger.

## Status

Early scaffold. Nothing here serves production traffic yet.
