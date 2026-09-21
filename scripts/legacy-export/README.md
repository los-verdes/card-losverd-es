# Legacy Postgres export

**Done: the production import ran and verified on 2026-09-21** (all five
counts matched the export). This is kept as the record of what was imported
and how, and because the export file it names is the only copy of the
Squarespace-era history once Postgres is decommissioned. Re-running any of it
against production now would overwrite live data; see "Starting over" below.

One-time copy of the legacy data that exists nowhere else (migration plan
Phase 2.2, `docs/legacy-pass-compatibility.md`):

* **`member_since_overrides`** (`source = 'legacy_postgres'`): each legacy
  user's earliest membership order date. For Squarespace-era members this is
  the only surviving record. Overrides win over the order-derived
  `members.member_since` wherever a pass is rendered.
* **`legacy_membership_cards`**: every legacy card, so QR codes already out
  in the world (`/verify-pass/{uuid}?signature=...`) can still be resolved.
* **`member_display_names`** (`source = 'legacy_postgres'`): names members
  chose for themselves on the old site, which had its own name-change page.
  Only the ones that differ from the name that member's latest order would
  produce; elsewhere the old system simply copied the billing name, and
  importing those would pin every member's name to whatever it was at
  the time of the import instead of letting it keep following the store.
* **`membership_orders`** (`first_seen_via = 'legacy_postgres'`): every
  membership order Postgres holds, Squarespace and BigCommerce alike. This
  is the order history behind admin reporting ("who was a member on a given
  date"), and the Squarespace-era rows survive nowhere else. BigCommerce
  orders use the same key as the live sync (the store's own order id), so the two never
  duplicate each other; for an order the sync already has, the import only
  fills in `member_email` (the member's current address, which only Postgres
  knows), and never for an order an admin has attributed since.

This is closed historical data. Run it any time before Postgres is
decommissioned (Phase 8.3); re-running it is safe. The export is
read-only against Postgres.

> The export and the generated SQL contain member names and emails. Keep
> them in `.legacy-export/` (gitignored) and delete them when done.

## 1. Export from Postgres

Connect with your usual Cloud SQL access (e.g. the Cloud SQL Auth Proxy),
then:

```bash
mkdir -p .legacy-export
psql "$LEGACY_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
  -f scripts/legacy-export/export.sql \
  -o .legacy-export/export.json
```

`export.sql` sets the session read-only and emits a single JSON document
(`-A -t` = no alignment/headers, `-q` suppresses command tags).

Before the real run, `column-checks.sql` answers the questions the export's
correctness rests on -- whether the `_bc` suffix the old app stored agrees
with each order's channel, which statuses exist, how many rows the filters
will emit.
It runs in the BigQuery console through the project's federated connection
and reads the Postgres columns directly, because the BigQuery *view* of
`annual_membership` strips that suffix and has misled us once. Every result
is a count, so the output can be pasted into an issue as-is.

## 2. Build the D1 import SQL

```bash
just legacy-import-sql .legacy-export/export.json .legacy-export/import.sql
```

This validates every row strictly, and aborts on anything unexpected rather
than skipping it. It prints row counts; sanity-check them against Postgres.
It also warns if any `annual_membership` rows could not be exported (no
order id, date, or email) -- look at those by hand before Postgres goes away.

## 3. Rehearse locally, then load into D1

The schema must already be applied (the Deploy workflow applies
`src/db/migrations/` on merge, and `just db-rebuild <env>` rebuilds it).

```bash
# local rehearsal
npx wrangler d1 migrations apply card-losverd-es-db-production --local
npx wrangler d1 execute card-losverd-es-db-production --local --file .legacy-export/import.sql

# real
npx wrangler d1 execute card-losverd-es-db-production --remote --file .legacy-export/import.sql
```

The import only writes the three tables above; it never modifies `members`.

### Belt and braces: mute production's email while backfilling

Nothing in the import sends email, and the three guards in
`src/email/newOrder.ts` exist precisely so that a backfill or a resync
cannot mail existing members. The resync that follows the import is the
riskiest thing this project does, though, and there is now a fourth guard
available that costs one command and takes effect immediately:

```bash
# before the import and the full resync that follows it
npx wrangler deploy --env="" --var EMAIL_RECIPIENT_ALLOWLIST:""
# afterwards, once the member counts have been checked
npx wrangler deploy --env=""     # restores the `*` in wrangler.toml
```

An empty allow-list means production emails nobody at all, so even a bug
that got past the other three would have nothing to deliver through. It is
worth doing for the real run rather than the rehearsals, since it is the run
where a mistake reaches people.

Wrangler prints a CLI-overridden var as `(hidden)` rather than showing its
value, so **confirm on `/admin/preflight`**: the "Who we may email" check
reports the restriction actually in force, which is the deployed Worker's
own answer rather than a claim about what was deployed.

Remember to put it back. While it is empty, a member using `/email-card`
gets silence, and the only signs are a suppressed send in the logs and that
same warning on the readiness page.
Overrides are keyed by email and applied when a pass is read, so members
created by BigCommerce sync after the import still pick up their legacy
date. Re-running the import never overwrites a `manual` override.

**Starting over.** Before the cutover the production database served nobody,
so the load was rehearsed: run, checked, emptied and run again. That is no
longer safe -- production serves members now, and the statement below
deletes their imported order history, legacy cards and "member since"
dates. It is kept for the record and for a disposable database only. The
one-shot step was always the *export*: once Postgres is decommissioned, the
Squarespace-era history exists only in the export file and in production.

What the rehearsals used to drop what the import wrote:

```bash
npx wrangler d1 execute card-losverd-es-db-production --remote --command   "DELETE FROM membership_orders WHERE first_seen_via = 'legacy_postgres'; DELETE FROM legacy_membership_cards; DELETE FROM member_since_overrides WHERE source = 'legacy_postgres'"
```

That leaves anything the BigCommerce sync recorded, and any `manual`
override, alone.

## 4. Check it landed

```bash
just legacy-import-verify production .legacy-export/export.json
```

Reads the counts back out of D1 and compares them against the export they
came from, one line per check, exiting non-zero if any disagree -- so it can
gate what happens next rather than being read and nodded at. It asks for
counts only and never reads a member's data, which is what makes it safe to
paste the output into an issue.

Four of the five checks are exact. Nothing but this import writes a
`legacy_postgres`-sourced override or display name, a legacy card, or a
Squarespace-era order -- that store closed in February 2023 and no other code
path can produce one. A count that is short means rows did not land; one that
is over means something wrote rows this import did not, which is worth
knowing too.

BigCommerce-era orders are checked as a lower bound instead, because the live
sync writes those as well. A rehearsal that follows a resync legitimately
holds more than the export carried, and the output says so rather than
calling it a failure.

Plan Phase 8.1 step 5 also asks for a spot-check of a few known early
members' `member_since` values, which is a person reading a handful of dates
rather than something to automate.

## Setting a member's "member since" date by hand

Any member's date can be set or corrected directly. A `manual` override
always wins, including over a later re-import:

```bash
npx wrangler d1 execute card-losverd-es-db-production --remote --command \
  "INSERT INTO member_since_overrides (email, member_since, source, note) VALUES ('jane@example.com', '2016-03-01', 'manual', 'founding member') ON CONFLICT(email) DO UPDATE SET member_since = excluded.member_since, source = 'manual', note = excluded.note, updated_at = unixepoch('subsec') * 1000"
```

Use the member's lower-cased email. Delete the row to fall back to the
order-derived date. Triggers on the table bump the member's
`last_updated_at`, so their pass is regenerated on its next fetch (no push is
sent; an installed pass picks the change up on its next update).
