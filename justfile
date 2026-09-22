set shell := ["bash", "-c"]
account_id := "42988f13a6daf00814bced22aff46f4e"
# The account's workers.dev subdomain. Per account, like the id above, so the
# two change together: each environment's Worker is reachable at
# `card-losverd-es-<env>.<this>.workers.dev`.

export TF_STATE_TOKEN_EXPIRES_ON := "2027-09-21"

# Default task: list available commands
default:
    @just --list

# `--dir` and `--out` below are real options (`[arg(..., long)]`, just 1.46+).
# Every other parameter is positional, which is what `just --list` shows but
# not what its `dir=".apple-pass-cert"` rendering looks like: written that way
# on the command line it is a value, not an assignment, and a directory of
# that name appears in the repository root.

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
db-migrate-local:
    npx wrangler d1 migrations apply DB --local --env=""

# Does an environment's database match what the migrations produce?
#
# Normally nothing has to ask: a database that applied every migration is by
# definition what they produce. A squash breaks that -- it rewrites what
# "already applied" means, so a database carrying the old history keeps the
# schema the old files built and nothing mentions that it is no longer one
# anybody can reproduce. This builds a throwaway database from the migrations
# and compares the two, object by object. Exits non-zero when they differ.
db-schema-compare env:
    #!/usr/bin/env bash
    set -euo pipefail
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    # `substr` rather than a LIKE with ESCAPE: the backslashes that needs do
    # not survive the trip through just and bash intact, and the Cloudflare
    # tables are the only ones that begin `_cf_`.
    query="SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' AND name != 'd1_migrations' ORDER BY type, name"
    npx wrangler d1 migrations apply DB --local --env="" --persist-to "$work/state" > /dev/null
    npx wrangler d1 execute DB --local --env="" --persist-to "$work/state" --json --command "$query" > "$work/expected.json"
    npx wrangler d1 execute card-losverd-es-db-{{ env }} --remote {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }} --json --command "$query" > "$work/actual.json"
    node scripts/schema-compare.mjs "$work/expected.json" "$work/actual.json"

# Empty an environment's database and rebuild it from the migrations -- the
# second half of a migration squash (docs/cutover.md, "Squash the
# migrations"). Drops every table, the migration log included, re-applies the
# migrations, then runs db-schema-compare, which exits non-zero if the result
# is not what the migrations build.
#
# Destroys everything in that database: members, orders, users and admin
# grants, the audit log, Wallet device registrations. Lists the tables and
# asks for the environment's name to be typed before touching anything. The
# account id is pinned so a wrangler login still pointing at another
# account cannot aim this at a different database of the same name.
#
# Afterwards it prints what has to be put back.
#
# Drop every table in an environment's database and rebuild it from the migrations
db-rebuild env:
    #!/usr/bin/env bash
    set -euo pipefail
    export CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'
    # An array, so `--env staging` stays two words and production's empty
    # environment name stays one empty word, whatever the shell does next.
    envflag=(--env "{{ if env == "production" { "" } else { env } }}")
    db="card-losverd-es-db-{{ env }}"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    npx wrangler d1 execute "$db" --remote "${envflag[@]}" --json \
      --command "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' ORDER BY name" \
      > "$work/tables.json"
    node scripts/db-drop-sql.mjs "$work/tables.json" "$work/drop.sql"
    echo
    read -r -p "Type '{{ env }}' to drop everything above in $db: " answer
    if [ "$answer" != "{{ env }}" ]; then echo "Not confirmed; nothing was changed."; exit 1; fi
    npx wrangler d1 execute "$db" --remote "${envflag[@]}" --file "$work/drop.sql"
    npx wrangler d1 migrations apply DB --remote "${envflag[@]}"
    just db-schema-compare {{ env }}
    echo
    echo "Rebuilt $db. Put back what it held:"
    echo "  - production: the imported pre-2023 history cannot be reloaded (the import tooling was removed in #215); restore with D1 Time Travel instead"
    echo "  - orders: just etl-run {{ env }} full-resync{{ if env == "production" { " --yes-production" } else { "" } }}   (never emails anyone)"
    echo "  - admins: just admin-grant {{ env }} <address> [<address> ...]   (no need to sign in first)"
    echo "  - Wallet passes already on phones: registrations are gone, so they get no updates until re-added"

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

# Read-only, so it is safe against a candidate token before swapping it in:
# creates nothing, changes nothing. Proves each permission group is granted,
# not that it is granted at Edit rather than Read -- only a staging deploy
# proves that. To try a narrowed token instead of the one in 1Password, run
# the script directly with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set.
#
# Check the Cloudflare API token has every permission Terraform and Deploy need
cloudflare-token-check:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/cloudflare-token-check.mjs

# Admin is a flag on the person's `users` row, checked on every admin request,
# so a grant or a revocation takes effect on their next page load. A grant
# works before someone has ever signed in -- it creates their account, and
# their first sign-in with that address picks it up -- and takes several
# addresses at once. Each grant and revocation is recorded in the audit log
# (/admin/audit). /admin/admins does the same from the browser; these work
# straight against D1, so they are the way in when nobody can reach that page.
#
# The account id is pinned so these never depend on which account wrangler
# happens to be logged into.
#
# List who has admin access in an environment
admin-list env:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/admin.mjs {{ env }} list

# Give one or more people admin access, signed in yet or not
admin-grant env +emails:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/admin.mjs {{ env }} grant {{ emails }}

# Take admin access away from one or more people
admin-revoke env +emails:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/admin.mjs {{ env }} revoke {{ emails }}

# Worker secrets: 1Password is the source of truth, since Cloudflare never
# returns a secret's value. One item per environment in the "Los Verdes" vault,
# `lv-card-losverd-es-worker-<env>`, with one field per secret labeled with its
# exact name (the full list is in scripts/worker-secrets.mjs). Values are piped
# straight through, never written to disk or passed as command-line arguments.
op_vault := "Los Verdes"
worker_secrets_item := "lv-card-losverd-es-worker-"

# Rotating a secret = edit it in 1Password, then push just that one, e.g.
# `just secrets-push staging AUTH_SECRET`. Uploads in a single deploy.
#
# Leading and trailing whitespace is trimmed on the way through, and the
# names it was trimmed from are printed. The exception is a value used as key
# material, where trimming would change the key rather than tidy it: those are
# refused instead, and named. See SIGNING_KEY_SECRETS in
# scripts/worker-secrets.mjs.
# Push Worker secrets from 1Password (all with values, or only NAMES)
secrets-push env *names:
    payload="$(op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/worker-secrets.mjs {{ env }} {{ names }})" && printf '%s' "$payload" | npx wrangler secret bulk {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }}

# Prints names, lengths, and line counts only -- never values.
# Show which Worker secrets 1Password and Cloudflare each have
secrets-status env:
    cloudflare="$(npx wrangler secret list --format json {{ if env == "production" { "--env=\"\"" } else { "--env " + env } }})" && op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/worker-secrets.mjs {{ env }} --status "$cloudflare"

# Enqueues onto the same etl-sync queue the cron uses, so the job runs exactly
# as it does on a schedule -- same retries, same dead-letter queue, same
# alerting. For watching a job once before trusting it to a timer, or
# re-running one after fixing what broke it. Production needs
# --yes-production.
#
# Run a scheduled job now: slack, resync, full-resync, readiness, or the one-off refresh-lapsed-passes
etl-run env job *flags:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/etl-run.mjs {{ env }} {{ job }} {{ flags }}

# Sends one `dlq_drill` message, which fails on purpose. Two modes, proving
# different things:
#
#   (default)  onto etl-sync, where it retries and dead-letters. Proves the
#              whole chain including the dead_letter_queue binding, which no
#              test can see. Takes about thirteen minutes.
#   --direct   straight onto the dead-letter queue. Proves the consumer and
#              webhook in seconds, and nothing about how a message reaches
#              them -- the right one after rotating a webhook.
#
# Defaults to staging; production needs --yes-production.
#
# Prove the dead-letter alert actually reaches Slack, in a real environment
queue-dlq-drill env="staging" *flags:
    CLOUDFLARE_API_TOKEN='op://{{ op_vault }}/lv-card-losverd-es-github-workflows/applier_token'     CLOUDFLARE_ACCOUNT_ID='{{ account_id }}'     op run -- node scripts/queue-dlq-drill.mjs {{ env }} {{ flags }}

# The two environments should share no secret values, so that a staging leak
# is not also a production compromise. Reads both 1Password items and reports
# only names and whether they match -- never a value. The few that genuinely
# cannot differ are listed in the script, each with its reason.
#
# Fail if staging and production share any secret value
secrets-compare:
    node scripts/secrets-compare.mjs

# A failed "Save to Google Wallet" link tells the member only "Something went
# wrong", and the JWT is validated inside Google, so there is nothing to tail.
# This separates the causes: credentials, class, object fields, issuer access.
# Read-only unless --insert is passed. Bundled first so it can use the
# Worker's own object builder rather than a second copy of it.
# Validate an environment's Google Wallet setup in detail
google-wallet-check env *flags:
    npx esbuild scripts/google-wallet-check.ts --bundle --platform=node --format=esm --packages=external --outfile=.google-wallet-check.mjs
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node .google-wallet-check.mjs {{ env }} {{ flags }}; status=$?; rm -f .google-wallet-check.mjs; exit $status
# Apple Pass Type ID certificate. Apple issues these for one year, so this
# comes round annually; the steps are few but easy to get subtly wrong, and a
# mismatched key or WWDR generation yields passes iOS rejects in silence. Run
# `apple-pass-cert-csr`, do the one manual step it prints in Apple's console,
# then `apple-pass-cert-install` -- which checks the download against the key
# and the chain, stores all three PEMs in 1Password, reads them back to
# confirm, pushes them, and deletes the local copies.
# Generate a private key and CSR for a new Apple pass certificate
[arg("dir", long)]
apple-pass-cert-csr dir=".apple-pass-cert":
    node scripts/apple-pass-cert.mjs csr --dir {{ dir }}

# Install the .cer Apple returned: verify it, store it, push it
[arg("dir", long)]
apple-pass-cert-install env cer dir=".apple-pass-cert":
    node scripts/apple-pass-cert.mjs install {{ cer }} --dir {{ dir }} --env {{ env }}
    op item edit "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" "APPLE_PASS_CERT_PEM[password]=$(cat {{ dir }}/pass-cert.pem)" "APPLE_PASS_KEY_PEM[password]=$(cat {{ dir }}/pass-key.pem)" "APPLE_WWDR_CERT_PEM[password]=$(cat {{ dir }}/wwdr.pem)" > /dev/null
    just apple-pass-cert-check {{ env }}
    just secrets-push {{ env }} APPLE_PASS_CERT_PEM APPLE_PASS_KEY_PEM APPLE_WWDR_CERT_PEM
    rm -rf {{ dir }}

# The key that tells an already-installed Wallet pass to come back for a new
# version. Without it a member who renews keeps seeing their old expiry until
# something else makes their phone re-fetch the pass, which is the one part of
# this that re-issuing cannot repair.
#
# Create the key in the Apple Developer portal (Certificates, Identifiers &
# Profiles -> Keys -> +), enabled for Apple Push Notifications service, scoped
# to this project's pass type identifier, with Production among its
# environments -- pass updates are only ever delivered from production APNs.
# Apple's .p8 downloads exactly once and is never recoverable, so this checks
# it before storing it, then removes the local copy.
#
# Store an APNs auth key and push it to an environment
apns-key-install env key_id p8:
    node scripts/apns-key.mjs check {{ p8 }} --key-id {{ key_id }}
    op item edit "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" "APNS_KEY_ID[password]={{ key_id }}" "APNS_PRIVATE_KEY_PEM[password]=$(cat {{ p8 }})" > /dev/null
    just secrets-push {{ env }} APNS_KEY_ID APNS_PRIVATE_KEY_PEM
    just apns-key-status {{ env }}
    rm -f {{ p8 }}

# Report which APNs key an environment has, if any
apns-key-status env:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/apns-key.mjs status

# Report what pass certificate an environment has and how long it has left
apple-pass-cert-check env:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/apple-pass-cert.mjs check --env {{ env }}

# Google Wallet rejects a save link whose class does not exist yet, and
# nothing else here creates it. Run once per environment, and again if the
# class changes. Flags: --dry-run.
# Create or update the environment's Google Wallet generic class
google-wallet-ensure-class env *flags:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/google-wallet-class.mjs {{ env }} {{ flags }}

# Uses the access token and webhook signing key from the environment's
# 1Password item and the store/client ids from wrangler.toml; re-run it after
# rotating BIGCOMMERCE_WEBHOOK_SIGNING_KEY. Flags: --dry-run; --origin URL
# (default PUBLIC_BASE_URL).
# Hooks outlive what they point at: after an account move, one registered
# against the old workers.dev hostname keeps being delivered to -- into an old
# deployment if it still runs, nowhere if not -- and nothing on the store's
# side looks wrong. This lists every hook with a verdict and, for anything not
# current, whether its destination still answers. `--delete <id>` removes one,
# chosen by a person; there is no sweep, because the store can hold hooks for
# things other than this project. The environment's own hostname comes from
# PUBLIC_BASE_URL; a hook on any other workers.dev host -- production's own
# included, since the flip -- is flagged stale.
#
# List the store's webhooks and flag any that no longer belong
bigcommerce-webhooks env *flags:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/bigcommerce-webhooks.mjs {{ env }} {{ flags }}

# Create or update the store's order webhook, with the header the Worker checks
bigcommerce-ensure-webhook env *flags:
    op item get "{{ worker_secrets_item }}{{ env }}" --vault "{{ op_vault }}" --reveal --format json | node scripts/bigcommerce-webhook.mjs {{ env }} {{ flags }}

# Terraform tasks (see terraform/README.md for required vars/env)
local_tf_cmd := f"""
AWS_ACCESS_KEY_ID='op://Los Verdes/lv-card-losverd-es-github-workflows/access_key_id' \\
AWS_SECRET_ACCESS_KEY='op://Los Verdes/lv-card-losverd-es-github-workflows/secret_access_key' \\
CLOUDFLARE_API_TOKEN='op://Los Verdes/lv-card-losverd-es-github-workflows/applier_token' \\
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

# Prepare the provenance doc for Google Docs, for the Merch Team and the
# Membership Committee to read and comment on. Upload the result to Drive, then
# right-click it and choose "Open with" -> "Google Docs". The repo's copy stays
# the source of truth; re-run this and re-import whenever it changes.
[arg("out", long)]
provenance-gdoc out=".provenance-gdoc.md":
    node scripts/provenance-gdoc.mjs {{out}}

