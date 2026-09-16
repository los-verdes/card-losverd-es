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
    npx wrangler d1 execute card-losverd-es-db --local --file=./src/db/schema.sql

db-migrate-local:
    npx wrangler d1 migrations apply card-losverd-es-db --local

db-migrate-remote:
    npx wrangler d1 migrations apply card-losverd-es-db --remote

# Create R2 bucket locally for testing
r2-init-local:
    npx wrangler r2 bucket create card-losverd-es-assets || true

# Deploy to Cloudflare Workers
deploy-preview:
    npx wrangler deploy --env preview

deploy-prod:
    npx wrangler deploy --env production

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

# Phase 1.0.1 risk spike: validate the PKCS#7 detached signature's ASN.1
# structure with `openssl smime -verify` (independent of this codebase's own
# unit tests -- a subtly-wrong PKCS#7 structure can pass a naive round-trip
# test while still being malformed). Requires `openssl` on PATH. Bundles
# first because the script's relative imports aren't resolvable by Node's
# native TS loader directly, and it needs plain Node (not workerd) to shell
# out to openssl.
verify-pkcs7-openssl:
    npx esbuild scripts/spikes/verify-pkcs7-openssl.ts --bundle --platform=node --format=esm --packages=external --outfile=.verify-pkcs7-bundle.mjs
    node .verify-pkcs7-bundle.mjs
    rm -f .verify-pkcs7-bundle.mjs
