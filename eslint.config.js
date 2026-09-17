// eslint.config.js
import { defineConfig } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default defineConfig([
	{
		ignores: ["coverage/**", "dist/**", ".wrangler/**", ".claude/**"],
	},
	{
		// Without an explicit `files` pattern, flat config only lints .js files.
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: { parser: tsParser },
		plugins: { "@typescript-eslint": tsPlugin },
		rules: {
			...tsPlugin.configs["eslint-recommended"].overrides[0].rules,
			...tsPlugin.configs.recommended.rules,
			semi: "error",
			"prefer-const": "error",
		},
	},
]);
