import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare const __D1_MIGRATIONS__: D1Migration[];

// Applies the real migrations from src/db/migrations against the isolated
// per-test-file D1 instance Miniflare provisions for the `DB` binding, so
// tests exercise the actual schema rather than a hand-copied duplicate of
// it. See vitest.config.ts for how __D1_MIGRATIONS__ is produced.
//
// Import this from any spec that needs a database:
//
//   import "../setup/d1";
//
// It is deliberately NOT a global setupFile. Provisioning the database
// costs a flat ~3 seconds per test file -- the same for one migration as
// for ten -- and 16 of the 40 spec files never query one, so paying it
// everywhere cost about a fifth of the suite's wall time for nothing.
// A spec that forgets this import fails loudly, with SQLite reporting no
// such table, so the failure mode is obvious rather than subtle.
await applyD1Migrations(env.DB, __D1_MIGRATIONS__);
