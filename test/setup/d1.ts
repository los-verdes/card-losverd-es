import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare const __D1_MIGRATIONS__: D1Migration[];

// Applies the real migrations from src/db/migrations against the isolated
// per-test-file D1 instance Miniflare provisions for the `DB` binding, so
// tests exercise the actual schema rather than a hand-copied duplicate of
// it. See vitest.config.ts for how __D1_MIGRATIONS__ is produced.
await applyD1Migrations(env.DB, __D1_MIGRATIONS__);
