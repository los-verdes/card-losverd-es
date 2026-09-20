# Cutover runbook

Moving `card.losverd.es` from the legacy GCP stack to this one, and retiring
GCP afterwards. Ordered: each section assumes the one before it is done.
Nothing here touches DNS until "The flip".

The ordering is not arbitrary and two steps in it are one-way. Those are
called out where they appear.

## 1. Validate on staging

Staging (`card-losverd-es-staging.jeff-hogan1.workers.dev`, BigCommerce
sandbox store `kouyh8feen`) is where every path gets exercised first:
webhook delivery, order sync, login with Google and with Apple, the portal,
the card image, both wallet passes, `/email-card`, `/verify-pass`, and the
admin reports.

**Start from `/admin/preflight`** (what it checks and why is in the
[README](../README.md#checking-whether-an-environment-is-ready)). The steps
no code can take -- a pass on a real phone, a save on Android, the reports
compared against the legacy one -- are listed on that same page, so there is
one list to work down rather than a second document to keep current.

## 2. Bring production up, still on its `workers.dev` hostname

None of this depends on DNS, so production can be fully working and
populated before anyone is pointed at it.

1. **Set every production secret**: `just secrets-push production`.
2. **Register the new OAuth callback URLs** with Google and Apple. **Add
   them; do not replace the legacy ones** -- the legacy app keeps serving
   logins until DNS moves, and removing its callbacks breaks it before
   anything has replaced it.

   The path changes, not just the host, which is easy to miss. The legacy
   app mounts python-social-auth at the root, so its callbacks are
   `/complete/google-oauth2/` and `/complete/apple/`. Auth.js uses
   `/api/auth/callback/google` and `/api/auth/callback/apple`. Register the
   `workers.dev` equivalents too, so login can be exercised before cutover.
3. **Turnstile**: the widget's allowed hostnames must include
   `card.losverd.es` as well as the `workers.dev` host, or `/email-card`
   fails bot verification.
4. **Google Wallet**: `just google-wallet-ensure-class production`, and
   confirm the issuer has publishing access rather than demo-only.
5. **Add a production `[triggers]` block** to `wrangler.toml`, with the same
   schedules `[env.staging.triggers]` already runs. Doing this now
   means D1 is populated and syncing before any member sees the new stack.
6. **Run the legacy Postgres export and import**
   ([`scripts/legacy-export/`](../scripts/legacy-export/README.md)).
   Rehearse the load rather than trying to get it right once: until cutover
   the production database serves nobody, so it can be loaded, checked,
   emptied and loaded again as often as needed.

   > **One-way step.** The *export* is not rehearsable. Postgres is
   > decommissioned in section 5 and the Squarespace-era order history in it
   > exists nowhere else -- the Squarespace account is gone. Take the export
   > early and carefully, and verify it before relying on it.

   Two things to settle before the *real* load. Whether a partially
   refunded order still confers membership
   ([#210](https://github.com/los-verdes/card-losverd-es/issues/210)): nine
   of them count today under the old system's rule and would stop counting
   here, and the status alone cannot say whether the membership or something
   else on the same order was refunded. And whether to empty production's
   `EMAIL_RECIPIENT_ALLOWLIST` for the duration -- a fourth guard over the
   three in `src/email/newOrder.ts`, on the one operation where a mistake
   reaches people.

   `/admin/preflight` counts imported orders that count for nothing once an
   import has run, which is the check to read after loading rather than a
   question to answer before it. The statuses themselves were enumerated
   against the real database before cutover
   ([#89](https://github.com/los-verdes/card-losverd-es/issues/89)), so
   nothing here should be a surprise.

7. **Run a full BigCommerce resync**, then reconcile member counts against
   BigCommerce's own admin.

   > **Order matters.** This must come *after* the legacy import. The import
   > sets orders' `member_email`, and cards are derived from it, so a resync
   > run first leaves members who have changed address holding cards under
   > their old one.

8. **Grant an admin**: log in once so the `users` row exists, then set
   `is_admin` (see the README). Worth doing as soon as login works rather
   than last, since `/admin/preflight` is admin-gated and is most useful
   while the rest of this list is still outstanding.

Before moving on, confirm on a real device: a `.pkpass` installs on an
iPhone and a membership change wakes it via APNs; a pass saves to Google
Wallet on Android; a QR code from a legacy pass verifies at `/verify-pass`;
and the admin reports agree with the legacy report.

## 3. The flip

`card.losverd.es` is currently a DNS-only CNAME to `ghs.googlehosted.com` in
the Cloudflare-hosted `losverd.es` zone.

1. Delete the `card` CNAME, then attach `card.losverd.es` to the production
   Worker as a Custom Domain -- preferably in `wrangler.toml` so it is
   deployed by merge rather than clicked. Cloudflare creates the proxied
   record and the certificate. A Custom Domain cannot be created while
   another record exists for the hostname, so expect a few minutes of
   downtime between the two steps.
2. **Update the production store's `store/order/*` webhook header** to the
   token computed from the new `BIGCOMMERCE_WEBHOOK_SIGNING_KEY`:
   `just bigcommerce-ensure-webhook production --cutover`. The existing
   subscription carries the legacy app's token, so until this is done the
   Worker answers 401 to every delivery. This is the easiest step to forget,
   because nothing looks broken -- BigCommerce retries for a while and the
   scheduled resync covers what is missed, so the symptom is delay rather
   than error. `/admin/preflight` checks it explicitly.
3. **Leave GCP running, including its Cloud Scheduler jobs.** Legacy stops
   receiving webhooks after the flip, but its scheduled sync keeps Postgres
   current, which is what keeps a rollback lossless for orders.
4. Watch `npx wrangler tail --env=""`: TLS works, both logins complete,
   webhooks arrive and sync, Apple devices poll. Failed-auth requests from
   installed *legacy* passes are expected and are not a problem -- those
   passes were never migrated.

**Rollback**: revert the route change and recreate the `card` CNAME to
`ghs.googlehosted.com`, DNS-only. Orders are unaffected, since BigCommerce
is the source and legacy kept syncing. What is lost is whatever happened
only on this side -- new logins, pass registrations, emails sent. Acceptable
here, but do not leave the window open indefinitely: Cloud Run's managed
certificate for the domain mapping may fail to renew while DNS points
elsewhere.

## 4. Settle

Wait at least one full reporting cycle, roughly two weeks.

Then retire the migration framing
([#186](https://github.com/los-verdes/card-losverd-es/issues/186)). This
repository is written throughout as a migration in progress -- this runbook
most of all -- and every one of those references stops being true on the day
of the flip. Left alone they do not read as history; they read as a project
that was abandoned midway. The issue separates what to sweep from the
references to the old system that stay correct indefinitely, which are not
the same thing and are easy to confuse.

## 5. Decommission GCP

Through the legacy repository's own `terraform/` configuration -- `terraform
destroy` or targeted state removal, not console or `gcloud` deletion, so
Terraform state stays consistent with reality.

Two gates first, both genuinely blocking:

- **The legacy export has run and been verified.** This is the last moment
  at which Postgres's Squarespace-derived history is recoverable at all. Do
  not proceed on the assumption it can be redone later; it cannot.
- **Reporting is replaced.** The admin reports have been checked against the
  legacy Data Studio report, and everyone who relied on that report can see
  the new one. Data Studio reads Cloud SQL directly, so destroying the
  database is what ends it.

Then: pause the Cloud Scheduler jobs; take a final export of the Cloud SQL
instance to cold storage as a historical record rather than for restore;
destroy the Cloud Run service, Cloud SQL instance, VPC connector and load
balancer; and confirm the billing account shows no daily burn.

Transferring the legacy GCP project itself is deliberately not on this list
-- it is being retired, not moved. What does need an organisation-owned home
is the Google configuration that outlives it, which is tracked in
[#158](https://github.com/los-verdes/card-losverd-es/issues/158).
