import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		environment: "edge-runtime",
		environmentMatchGlobs: [
			["src/test/browser/**", "browser"],
			["src/test/unit/**", "edge-runtime"],
			["src/test/integration/**", "jsdom"],
		],
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/test/**/*.test.ts"],
		server: { deps: { inline: ["convex-test"] } },
	},
	resolve: {
		alias: {
			$: path.resolve(__dirname, "./src"),
			"$/component": path.resolve(__dirname, "./src/component"),
		},
	},
});
