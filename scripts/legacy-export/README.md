# Legacy Postgres export

One-time copy of the two pieces of legacy data that exist nowhere else
(migration plan Phase 2.2, `docs/legacy-pass-compatibility.md`):

* **`member_since_overrides`** (`source = 'legacy_postgres'`): each legacy
  user's earliest membership order date. For Squarespace-era members this is
  the only surviving record. Overrides win over the order-derived
  `members.member_since` wherever a pass is rendered.
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

The import only writes the two tables above; it never modifies `members`.
Overrides are keyed by email and applied when a pass is read, so members
created by BigCommerce sync after the import still pick up their legacy
date. Re-running the import never overwrites a `manual` override.

## 4. Spot-check

```bash
npx wrangler d1 execute card-losverd-es-db --remote --command \
  "SELECT (SELECT COUNT(*) FROM member_since_overrides WHERE source = 'legacy_postgres') AS member_since_rows, (SELECT COUNT(*) FROM legacy_membership_cards) AS cards, (SELECT MIN(member_since) FROM member_since_overrides) AS earliest"
```

Plan Phase 8.1 step 5 also asks for a spot-check of a few known early
members' `member_since` values.

## Setting a member's "member since" date by hand

Any member's date can be set or corrected directly. A `manual` override
always wins, including over a later re-import:

```bash
npx wrangler d1 execute card-losverd-es-db --remote --command \
  "INSERT INTO member_since_overrides (email, member_since, source, note) VALUES ('jane@example.com', '2016-03-01', 'manual', 'founding member') ON CONFLICT(email) DO UPDATE SET member_since = excluded.member_since, source = 'manual', note = excluded.note, updated_at = unixepoch('subsec') * 1000"
```

Use the member's lower-cased email. Delete the row to fall back to the
order-derived date. Triggers on the table bump the member's
`last_updated_at`, so their pass is regenerated on its next fetch (no push is
sent; an installed pass picks the change up on its next update).
