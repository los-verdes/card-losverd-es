import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
	// Read the D1 migrations from disk here (Node context, config-time) so
	// they can be applied inside the Workers runtime by test/setup/d1.ts via
	// `applyD1Migrations()` - see docs/bigcommerce-ingestion.md section 4.
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "src/db/migrations"));

	return {
		plugins: [
			cloudflareTest({
				wrangler: {
					configPath: "./wrangler.toml",
				},
			}),
		],
		define: {
			__D1_MIGRATIONS__: JSON.stringify(migrations),
		},
		test: {
			setupFiles: ["./test/setup/d1.ts"],
			// Vitest's 5000ms default is too tight for the first test in any file
			// that calls getTestCertChain() (src/spikes/pkcs7-signing/certs.ts):
			// it generates two fresh 2048-bit RSA keys via node-forge, memoized
			// only per test *file* (each file runs in its own isolated worker), so
			// that cost is paid at least once per file and can exceed 5s on a
			// loaded CI runner -- seen failing intermittently in test/passkit/signer.spec.ts.
			testTimeout: 20000,
			// Extends (not replaces) Vitest's own defaults, which don't cover
			// `.claude/` -- without this, test files inside a background-agent
			// worktree checked out under `.claude/worktrees/` (a separate,
			// potentially stale/in-progress copy of this same repo) get picked up
			// too, double-running tests and corrupting coverage with that
			// worktree's own source tree once its tests import it.
			exclude: [...configDefaults.exclude, "**/.claude/**"],
			coverage: {
				provider: "istanbul",
				reporter: ["text", "json", "html"],
				thresholds: {
					lines: 95,
					functions: 95,
					branches: 90,
					statements: 95,
				},
			},
		},
	};
});
