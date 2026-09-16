# Legacy Postgres export

One-time copy of the two pieces of legacy data that exist nowhere else
(migration plan Phase 2.2, `docs/legacy-pass-compatibility.md`):

* **`legacy_member_since`**: each legacy user's earliest membership order
  date. For Squarespace-era members this is the only surviving record.
* **`legacy_membership_cards`**: every legacy card, so QR codes already out
  in the world (`/verify-pass/{uuid}?signature=...`) can still be resolved.

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

## 2. Build the D1 import SQL

```bash
just legacy-import-sql .legacy-export/export.json .legacy-export/import.sql
```

This validates every row strictly, and aborts on anything unexpected rather
than skipping it. It prints row counts; sanity-check them against Postgres.

## 3. Rehearse locally, then load into D1

Migration `0005_legacy_export.sql` must already be applied (the Deploy
workflow does this on merge).

```bash
# local rehearsal
npx wrangler d1 migrations apply card-losverd-es-db --local
npx wrangler d1 execute card-losverd-es-db --local --file .legacy-export/import.sql

# real
npx wrangler d1 execute card-losverd-es-db --remote --file .legacy-export/import.sql
```

Besides filling the two legacy tables, the import moves `members.member_since`
earlier for any **existing** `members` row whose legacy date is earlier.
Members created by BigCommerce sync *after* the import don't pick up their
legacy date until the sync reads `legacy_member_since` itself (tracked
follow-up); until then, re-running the import after a full resync
(`sync_subscriptions_etl` with `loadAll`) catches them up.

## 4. Spot-check

```bash
npx wrangler d1 execute card-losverd-es-db --remote --command \
  "SELECT (SELECT COUNT(*) FROM legacy_member_since) AS member_since_rows, (SELECT COUNT(*) FROM legacy_membership_cards) AS cards, (SELECT MIN(member_since) FROM legacy_member_since) AS earliest"
```

Plan Phase 8.1 step 5 also asks for a spot-check of a few known early
members' `member_since` values.
