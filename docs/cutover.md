# Cutover runbook

Moving `card.losverd.es` from the legacy GCP stack to this one, and retiring
GCP afterwards.

**The hostname is settled and is `card.losverd.es`.** Moving the card site
under the group's main domain was considered and deliberately deferred.

The obvious way to do it would be to delegate just the subdomain: leave
`losverdesatx.org` where it is and hand `card.losverdesatx.org` to Cloudflare
with an `NS` record. Cloudflare supports exactly that, and calls it a
subdomain setup -- but only on Enterprise plans, which is not where this
project lives. Without it, a Workers Custom Domain needs the hostname to sit
in an active zone on the account, so the alternative is moving
`losverdesatx.org`'s DNS to Cloudflare wholesale. That zone carries the
group's main site and its mail, and blocking the migration on moving it is
not a trade worth making.

None of that is lost by waiting. A move can happen later without touching
anybody's installed pass, because `card.losverd.es` would redirect.

That redirect is the part with no end date. Every QR code already printed or
installed encodes `card.losverd.es`, and every Apple pass stores its update
URL at issuance -- a pass never learns a new one, it just stops updating. So
whatever else changes, **that hostname has to keep resolving for as long as
any of those cards exist**, which is why the domain is on the list of things
that must belong to the group rather than to a person
([#158](https://github.com/los-verdes/card-losverd-es/issues/158)). Ordered: each section assumes the one before it is done.
Nothing here touches DNS until "The flip".

The ordering is not arbitrary and two steps in it are one-way. Those are
called out where they appear.

## 1. Validate on staging

Staging (`card-losverd-es-staging.los-verdes.workers.dev`, BigCommerce
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
6. **Squash the migrations, if that is still wanted**
   ([#201](https://github.com/los-verdes/card-losverd-es/issues/201)). A
   squash rewrites what "already applied" means, so it is only safe while
   every database can be thrown away and rebuilt from scratch.

   What keeps that true is not this step's position in the list but whether
   the Squarespace-era history still exists somewhere else. Two things can
   hold it: Postgres, until it is decommissioned in section 5, and the export
   JSON, for as long as that file is kept. While either survives, production
   can be emptied and loaded again, so the squash is still available -- a
   first import does not close the window on its own.

   What does close it is the last of those going away. After that production
   holds the only copy, and no squash can be undone by recreating the
   database. Keep the export file until this is either done or decided
   against.

   Nothing breaks by skipping it. It is a tidying of the migration history,
   several of whose files exist only to correct earlier ones, and the cost of
   not doing it is that they stay.

   **A squash is not finished until the databases are rebuilt.** A database
   that ran the old files keeps the schema those files built, which is not
   quite the schema the new one builds -- a column added by `ALTER TABLE`
   sits at the end of the table, where a declared one sits where it is
   written. Every query this project makes names its columns, so nothing
   breaks; what is lost is being able to recreate the database from the
   migrations, which is the thing the migrations are for.

   So after squashing, for each environment: `just db-rebuild <env>` drops
   every table (children before parents, the migration log included), applies
   the migrations, and ends with `just db-schema-compare <env>`, which builds a
   throwaway database from the migrations and compares the two object by
   object. It exits non-zero while they differ, so it can gate the step rather
   than be read and nodded at. Then reload what the database held; the recipe
   prints the list.

   For production that reload is the legacy import below, which is why the
   export file has to still be around.

7. **Run the legacy Postgres export and import**
   ([`scripts/legacy-export/`](../scripts/legacy-export/README.md)).
   Rehearse the load rather than trying to get it right once: until cutover
   the production database serves nobody, so it can be loaded, checked,
   emptied and loaded again as often as needed.

   > **One-way step.** The *export* is not rehearsable. Postgres is
   > decommissioned in section 5 and the Squarespace-era order history in it
   > exists nowhere else -- the Squarespace account is gone. Take the export
   > early and carefully, and verify it before relying on it.

   Production's `EMAIL_RECIPIENT_ALLOWLIST` is empty until the flip, so the
   environment can email nobody at all. That is a fourth guard over the three
   in `src/email/newOrder.ts`, and the only one that does not depend on the
   send path being reached by the route we expect. It is restored in
   [section 3](#3-the-flip).

   No member loses a card they hold today. This was measured against the
   full export once it was loaded, rather than assumed
   ([#89](https://github.com/los-verdes/card-losverd-es/issues/89)): of the
   544 addresses holding an imported order that does not count here, 535 also
   hold one that does, and the nine holding none were never issued a card by
   the previous site either. The paid-only allow-list reproduces the old
   system's outcomes.

   The `Partially Refunded` orders are the one real behaviour difference
   ([#210](https://github.com/los-verdes/card-losverd-es/issues/210)): nine
   orders, nine people, and eight of them did hold a card from the old site,
   so that store counted what this one does not. All nine have expired,
   though, so the difference is historical and nobody is losing anything.
   Should a live one ever appear, the intended outcome is still that it does
   not count -- the status is as likely to be stale, or left from a renewal
   problem long since resolved, as it is to describe anything current.

   Check the load with `just legacy-import-verify production <export.json>`
   before going on. It compares D1's counts against the export they came from
   and exits non-zero if they disagree, which is the difference between
   knowing the import landed and assuming it.

   `/admin/preflight` counts imported orders that count for nothing once an
   import has run, which is the check to read after loading rather than a
   question to answer before it. The statuses themselves were enumerated
   against the real database before cutover
   ([#89](https://github.com/los-verdes/card-losverd-es/issues/89)), so
   nothing here should be a surprise.

8. **Run a full BigCommerce resync** (`just etl-run production full-resync
   --yes-production`), then reconcile member counts against BigCommerce's
   own admin.

   > **Order matters.** This must come *after* the legacy import. The import
   > sets orders' `member_email`, and cards are derived from it, so a resync
   > run first leaves members who have changed address holding cards under
   > their old one.

9. **Grant admins**: `just admin-grant production <address> [<address> ...]`
   (see the README). Nobody needs to have signed in first, so this can be
   done for the whole group at once, and early rather than last:
   `/admin/preflight` is admin-gated and is most useful while the rest of
   this list is still outstanding.

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
2. **Restore `EMAIL_RECIPIENT_ALLOWLIST` to `*`** in `wrangler.toml` and
   deploy. It has been empty since before the import, so until this is done
   production can email nobody: a member using /email-card gets a page saying
   their card is on its way and nothing arrives. `/admin/preflight` fails on
   this once the Worker is serving `card.losverd.es`, which is the safety net
   rather than the plan.
3. **Update the production store's `store/order/*` webhook header** to the
   token computed from the new `BIGCOMMERCE_WEBHOOK_SIGNING_KEY`:
   `just bigcommerce-ensure-webhook production --cutover`. The existing
   subscription carries the legacy app's token, so until this is done the
   Worker answers 401 to every delivery. This is the easiest step to forget,
   because nothing looks broken -- BigCommerce retries for a while and the
   scheduled resync covers what is missed, so the symptom is delay rather
   than error. `/admin/preflight` checks it explicitly.
4. **Leave GCP running, including its Cloud Scheduler jobs.** Legacy stops
   receiving webhooks after the flip, but its scheduled sync keeps Postgres
   current, which is what keeps a rollback lossless for orders.
5. Watch `npx wrangler tail --env=""`: TLS works, both logins complete,
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

Sweeping Squarespace out of the code
([#215](https://github.com/los-verdes/card-losverd-es/issues/215)) belongs to
the same pass, with one ordering rule: **freeze each imported order's verdict
first**. The freeze runs the current counting rule, era branch included, over
the imported rows once and records the result in a column the reports read
for closed years. Delete the era branch before that and there is nothing
left to freeze -- the BigCommerce rule would rescore almost every Squarespace
order, and the 2019--2022 figures would change without anyone deciding they
should.

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
