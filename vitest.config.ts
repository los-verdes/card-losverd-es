import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./wrangler.toml",
			},
		}),
	],
	test: {
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
});
