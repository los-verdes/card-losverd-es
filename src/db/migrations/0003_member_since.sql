-- Adds the "member since" date used on the pass/card face, per Phase 2.1/2.2
-- of `.ai/gcp-to-cf_plan.md`. For members with BigCommerce-only history this
-- is derivable from synced order data; for early members it's only
-- recoverable from historical Squarespace orders in Postgres (Squarespace
-- itself is no longer accessible) and gets backfilled once from there -- see
-- the plan for the full design. Additive-only, per this repo's migration
-- house rule (see justfile / CI).
ALTER TABLE members ADD COLUMN member_since TEXT; -- ISO8601 date (YYYY-MM-DD)
