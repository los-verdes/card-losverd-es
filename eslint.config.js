// eslint.config.js
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: ["coverage/**", "dist/**", ".wrangler/**"],
	},
	{
		rules: {
			semi: "error",
			"prefer-const": "error",
		},
	},
]);
