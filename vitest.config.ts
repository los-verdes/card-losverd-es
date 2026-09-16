import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
