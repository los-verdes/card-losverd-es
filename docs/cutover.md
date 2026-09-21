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
6. **Squash the migrations, if that is still wanted**
   ([#201](https://github.com/los-verdes/card-losverd-es/issues/201)). This is
   the last moment it is safe, and the moment was chosen deliberately: a
   squash rewrites what "already applied" means, so it only works while every
   database can be thrown away and rebuilt from scratch. The step below is
   what ends that -- afterwards production holds the only copy of the
   Squarespace-era history, and no later squash can be undone by recreating
   the database.

   Nothing breaks by skipping it. It is a tidying of fifteen migrations,
   several of which exist only to correct earlier ones, and the cost of not
   doing it is that they stay.

7. **Run the legacy Postgres export and import**
   ([`scripts/legacy-export/`](../scripts/legacy-export/README.md)).
   Rehearse the load rather than trying to get it right once: until cutover
   the production database serves nobody, so it can be loaded, checked,
   emptied and loaded again as often as needed.

   > **One-way step.** The *export* is not rehearsable. Postgres is
   > decommissioned in section 5 and the Squarespace-era order history in it
   > exists nowhere else -- the Squarespace account is gone. Take the export
   > early and carefully, and verify it before relying on it.

   One thing to settle before the *real* load: whether to empty production's
   `EMAIL_RECIPIENT_ALLOWLIST` for the duration -- a fourth guard over the
   three in `src/email/newOrder.ts`, on the one operation where a mistake
   reaches people.

   Expect nine members to lose a membership they hold today. They are the
   orders the old store left as `Partially Refunded`, which counted there and
   do not count here
   ([#210](https://github.com/los-verdes/card-losverd-es/issues/210)). That is
   the intended outcome rather than a surprise: the status is as likely to be
   stale, or left over from a renewal problem long since resolved, as it is to
   describe anything current. If members write in afterwards, that is the
   moment to work out what produces the status -- not before, on nine rows.

   `/admin/preflight` counts imported orders that count for nothing once an
   import has run, which is the check to read after loading rather than a
   question to answer before it. The statuses themselves were enumerated
   against the real database before cutover
   ([#89](https://github.com/los-verdes/card-losverd-es/issues/89)), so
   nothing here should be a surprise.

8. **Run a full BigCommerce resync**, then reconcile member counts against
   BigCommerce's own admin.

   > **Order matters.** This must come *after* the legacy import. The import
   > sets orders' `member_email`, and cards are derived from it, so a resync
   > run first leaves members who have changed address holding cards under
   > their old one.

9. **Grant an admin**: log in once so the `users` row exists, then set
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
