set shell := ["bash", "-c"]

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
    npx eslint src test
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
