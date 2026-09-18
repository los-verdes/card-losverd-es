set shell := ["bash", "-c"]
account_id := "ff1b7ea0ebb95f46b7b15289ed8ce21d"

# Default task: list available commands
default:
    @just --list

# Install dependencies
install:
    npm install

# Run local development server with local D1 and R2 emulation
dev:
    npx wrangler dev

# Run Vitest test suite
test:
    npx vitest run

# Run tests with coverage report (enforces >= 95% target)
test-coverage:
    npx vitest run --coverage

# Type check
typecheck:
    npx tsc --noEmit

# Lint and format
lint:
    npx eslint .
format:
    npx prettier --write "src/**/*.{ts,sql,json}"

# D1 database tasks
db-init-local:
    npx wrangler d1 execute DB --local --env="" --file=./src/db/schema.sql

db-migrate-local:
    npx wrangler d1 migrations apply DB --local --env=""

# Apply D1 migrations to an environment's remote database (production or
# staging); CI runs this on deploy.
db-migrate-remote env="production":
    npx wrangler d1 migrations apply DB --remote {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }}

# Create R2 bucket locally for testing
r2-init-local:
    npx wrangler r2 bucket create card-losverd-es-assets-local || true

# Upload the committed template images (assets/templates/**) to an
# environment's R2 bucket (card-losverd-es-assets-<env>) under the same keys
# (templates/**): the Apple pass icons/logos pass generation reads, and the
# card image crest. Idempotent -- the Deploy workflow runs it on every deploy.
# Pass `--local` as the target for local dev R2.
r2-upload-templates env="production" target="--remote":
    cd assets && find templates -type f -name '*.png' | sort | while read -r key; do npx wrangler r2 object put "card-losverd-es-assets-{{ env }}/$key" --file "$key" --content-type image/png {{target}}; done

# Deploy to Cloudflare Workers: `just deploy` (production) or `just deploy
# staging`. CI normally does this (see .github/workflows/deploy.yml). The
# explicit `--env=""` targets the top-level (production) config and avoids
# Wrangler's "multiple environments defined, no target specified" warning.
deploy env="production":
    npx wrangler deploy {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }}

# Fail if an environment's var/binding names drift from production's, or if it
# points at a production resource (named environments inherit neither). Runs
# in CI.
check-wrangler-envs:
    node scripts/check-wrangler-envs.mjs

# Worker secrets: 1Password is the source of truth, since Cloudflare never
# returns a secret's value. One item per environment in the "Los Verdes" vault,
# `lv-card-losverd-es-worker-<env>`, with one field per secret labeled with its
# exact name (the full list is in scripts/worker-secrets.mjs). Values are piped
# straight through, never written to disk or passed as command-line arguments.
op_vault := "Los Verdes"
worker_secrets_item := "lv-card-losverd-es-worker-"

# Rotating a secret = edit it in 1Password, then push just that one, e.g.
# `just secrets-push staging AUTH_SECRET`. Uploads in a single deploy.
# Push Worker secrets from 1Password (all with values, or only NAMES)
secrets-push env *names:
    payload="$(op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/worker-secrets.mjs {{ env }} {{ names }})" && printf '%s' "$payload" | npx wrangler secret bulk {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }}

# Prints names, lengths, and line counts only -- never values.
# Show which Worker secrets 1Password and Cloudflare each have
secrets-status env:
    cloudflare="$(npx wrangler secret list --format json {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }})" && op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/worker-secrets.mjs {{ env }} --status "$cloudflare"

# A failed "Save to Google Wallet" link tells the member only "Something went
# wrong", and the JWT is validated inside Google, so there is nothing to tail.
# This separates the causes: credentials, class, object fields, issuer access.
# Read-only unless --insert is passed. Bundled first so it can use the
# Worker's own object builder rather than a second copy of it.
# Validate an environment's Google Wallet setup in detail
google-wallet-check env *flags:
    npx esbuild scripts/google-wallet-check.ts --bundle --platform=node --format=esm --packages=external --outfile=.google-wallet-check.mjs
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node .google-wallet-check.mjs {{ env }} {{ flags }}; status=$?; rm -f .google-wallet-check.mjs; exit $status

# Google Wallet rejects a save link whose class does not exist yet, and
# nothing else here creates it. Run once per environment, and again if the
# class changes. Flags: --dry-run.
# Create or update the environment's Google Wallet generic class
google-wallet-ensure-class env *flags:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/google-wallet-class.mjs {{ env }} {{ flags }}

# Uses the access token and webhook signing key from the environment's
# 1Password item and the store/client ids from wrangler.toml; re-run it after
# rotating BIGCOMMERCE_WEBHOOK_SIGNING_KEY. Flags: --dry-run; --origin URL
# (default PUBLIC_BASE_URL); --cutover (production's card.losverd.es origin is
# refused until then, since the legacy app's webhook lives there).
# Create or update the store's order webhook, with the header the Worker checks
bigcommerce-ensure-webhook env *flags:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/bigcommerce-webhook.mjs {{ env }} {{ flags }}

# Terraform tasks (see terraform/README.md for required vars/env)
local_tf_cmd := f"""
AWS_ACCESS_KEY_ID='op://Los Verdes/lv-card-losverd-es-github-workflows/access_key_id' \\
AWS_SECRET_ACCESS_KEY='op://Los Verdes/lv-card-losverd-es-github-workflows/secret_access_key' \\
CLOUDFLARE_API_TOKEN='op://Los Verdes/lv-card-losverd-es-github-workflows/credential' \\
TF_VAR_cloudflare_account_id='{{ account_id }}' \\
op run -- terraform"""
tf_subdir := "terraform"

tf_cmd := if env_var_or_default("CI", "") != "" { "terraform" } else { local_tf_cmd }

tf +CMD:
   {{ tf_cmd }} -chdir="{{ justfile_directory() + "/" + tf_subdir }}" \
      {{ CMD }}

tf-init:
    just tf init

tf-plan:
    just tf plan

tf-apply:
    just tf apply

# Validate the PKCS#7 detached signature src/passkit/signer.ts produces with
# `openssl smime -verify` -- independent of this codebase's own unit tests, a
# subtly-wrong PKCS#7 structure can pass a naive round-trip test while still
# being malformed. Requires `openssl` on PATH. Bundles first because the
# script's relative imports aren't resolvable by Node's native TS loader
# directly, and it needs plain Node (not workerd) to shell out to openssl.
verify-pkcs7-openssl:
    npx esbuild scripts/verify-pkcs7-openssl.ts --bundle --platform=node --format=esm --packages=external --outfile=.verify-pkcs7-bundle.mjs
    node .verify-pkcs7-bundle.mjs
    rm -f .verify-pkcs7-bundle.mjs

# Legacy Postgres export -> D1 import SQL (one-time; see
# scripts/legacy-export/README.md). Bundled first for the same reason as
# verify-pkcs7-openssl above.
legacy-import-sql export_json out_sql:
    npx esbuild scripts/legacy-export/build-import-sql.ts --bundle --platform=node --format=esm --packages=external --outfile=.legacy-import-bundle.mjs
    node .legacy-import-bundle.mjs {{export_json}} {{out_sql}}
    rm -f .legacy-import-bundle.mjs
