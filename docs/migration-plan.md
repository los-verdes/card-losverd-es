# Migration plan: phase index

The plan that drove this rewrite specified it in detail before the build.
The code now specifies itself at the point of use, and what remains here is
an index. Dozens of comments cite a phase number, so the numbering is
preserved and each entry says what that phase covered and where its detail
lives now.

The decisions that shaped the whole project are in
[`architecture-decisions.md`](architecture-decisions.md). The one phase that
is still ahead of us, Phase 8, is [`cutover.md`](cutover.md).

## Phase 0 -- Repository archiving and state baseline

**0.1** The legacy repository's state at the point of migration is preserved
on the branch `archive/gcp-production` and the tag `v-legacy-gcp`.

**0.2** An inventory of the legacy schema, pass assets, credentials and
operational logs. One decision from it still matters: **APNs uses `.p8`
token auth rather than a push certificate**, and that key had to be created
because the legacy app never sent pushes at all.

**0.3** An inventory of every integration holding a URL or credential
registered with a third party, rather than resolved through DNS. Those are
the things a DNS cutover does *not* move, and they are now steps in
[`cutover.md`](cutover.md).

## Phase 1 -- Tooling and local development

**1.0** Two risk spikes, run before anything else was built, because both
were capable of invalidating the whole approach:

- **PKCS#7 pass signing on Workers**, validated against `openssl smime
  -verify` and a real device rather than this codebase's own tests -- a
  subtly wrong ASN.1 structure passes a round-trip test and still fails
  Wallet. `just verify-pkcs7` keeps that independent check available.
- **Card image rendering** with Satori and `@resvg/resvg-wasm`, replacing a
  headless browser. Three Workers-specific constraints came out of it, all
  now recorded where they would be undone: WASM must be statically imported
  rather than compiled at runtime, Satori's remote image fetching fails
  silently so images must be inlined as data URLs, and Satori rasterises
  only to PNG and JPEG.

**1.1--1.4** Project layout, dependencies, the `justfile` as sole task
runner, and one Worker secret per credential rather than a bundled blob.
All superseded by the repository itself: `just --list`, `package.json`, and
the README's secrets section.

## Phase 2 -- D1 schema and data

**2.1** The schema. Superseded by `src/db/schema.sql` and the migrations
beside it, which are what actually runs.

**2.2** How D1 gets populated: BigCommerce sync as the ongoing source, plus
a one-time export of what only the legacy Postgres holds. Two decisions
survive and are documented where they apply --
[`legacy-pass-compatibility.md`](legacy-pass-compatibility.md) for why
installed Wallet passes are not migrated, and
[`scripts/legacy-export/`](../scripts/legacy-export/README.md) for the
export itself. The rule that a later sync must not clobber a backfilled
`member_since` is enforced in `src/bigcommerce/sync.ts` and pinned by a
test.

## Phase 2.3 -- Member authentication

Session strategy, OAuth, and the authorisation middleware. The reasoning is
in the code: `src/auth/session.ts` explains why the session cookie is
`SameSite=Lax` where the legacy one was `None`, and why
`SESSION_SIGNING_KEY` is a fresh secret rather than a carry-over of the
legacy `SECRET_KEY` -- which had two unrelated jobs. `src/auth/authjs.ts`
covers the OAuth bridge, and `src/middleware/auth.ts` the middleware.

Dropped during this phase: Yahoo login, the BigCommerce storefront SSO
handoff, and the provider-disconnect flow.

## Phase 2.5 -- Queues and scheduled work

**2.5.1** Two decisions worth keeping. **Email distribution gets no queue**
-- it runs inline under `ctx.waitUntil()`, because a failed send is better
retried by the member than by a queue. And the originally planned
`member-actions` queue was **retired** before being built: card images
render on request, so there was nothing left to fan out.

**2.5.2--2.5.6** Queue configuration, cron mapping, message schemas and
producer call sites. Superseded by `wrangler.toml`, `src/scheduled.ts` and
`src/queues/etlSync.ts`, where the message type union is the schema.

## Phase 3 -- R2

Bucket layout, asset upload, and the pass cache. Superseded by
`src/assets.ts`, `just r2-upload-templates`, and the caching in
`src/passkit/generator.ts` -- which keys on both the member's
`last_updated_at` and a pass content version, so that changing what a pass
contains reaches members whose own details have not changed.

## Phase 4 -- Apple PassKit web service

Device registration, the update-polling endpoint, pass delivery,
unregistration, device logging, PKCS#7 signing, and APNs pushes. All built;
`src/passkit/` is the specification now, and the protocol behaviour is
pinned by `test/passkit/`.

## Phase 5 -- Google Wallet

Save links, RS256 JWT signing via Web Crypto, and the prerequisites an
issuer account has to satisfy. Built in `src/google/`. The prerequisites --
the class existing, the issuer having publishing access rather than demo
only -- are checked by `/admin/preflight` and by `just
google-wallet-check`, which exist because Google reports every one of those
failures as the same generic error.

## Phase 6 -- Testing

Unit, contract and integration coverage, with thresholds enforced in CI.
Superseded by `vitest.config.ts` and the suite. The one rule worth
restating: the coverage threshold is a floor to stop regressions, not a
target to hit -- a test that exists to move a percentage is worse than no
test.

## Phase 7 -- CI and deployment

Both workflows are built and in use; `.github/workflows/` is the reference,
and the README describes what each run does. The house rule that makes
deploy-on-merge safe is that migrations are additive, so a deploy never
needs to be ordered against a schema change.

## Phase 8 -- Cutover

Still ahead. See [`cutover.md`](cutover.md).
