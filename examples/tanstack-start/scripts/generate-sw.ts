import { injectManifest } from "workbox-build";
import { resolve } from "node:path";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

const distClient = resolve(import.meta.dirname, "../.output/public");
const srcSw = resolve(import.meta.dirname, "../src/sw.ts");

async function generateServiceWorker() {
	if (!existsSync(distClient)) {
		console.error("Error: .output/public does not exist. Run `vite build` first.");
		process.exit(1);
	}

	console.log("Transpiling service worker...");
	const transpiled = await Bun.build({
		entrypoints: [srcSw],
		format: "esm",
		target: "browser",
		minify: true,
	});

	if (!transpiled.success) {
		console.error("Failed to transpile service worker:");
		for (const log of transpiled.logs) {
			console.error(log);
		}
		process.exit(1);
	}

	const swJsContent = await transpiled.outputs[0].text();
	const tempSwPath = resolve(distClient, "sw-src.js");
	writeFileSync(tempSwPath, swJsContent);

	console.log("Generating service worker with workbox...");

	try {
		const { count, size, warnings } = await injectManifest({
			swSrc: tempSwPath,
			swDest: resolve(distClient, "sw.js"),
			globDirectory: distClient,
			globPatterns: ["**/*.{js,css,ico,png,svg,woff2,webmanifest}"],
			globIgnores: ["sw-src.js", "sw.js"],
			maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
		});

		unlinkSync(tempSwPath);

		if (warnings.length > 0) {
			console.warn("Warnings:", warnings.join("\n"));
		}

		console.log(
			`Service worker generated with ${count} files, totaling ${(size / 1024).toFixed(1)} KB`,
		);
	} catch (error) {
		if (existsSync(tempSwPath)) {
			unlinkSync(tempSwPath);
		}
		console.error("Error generating service worker:", error);
		process.exit(1);
	}
}

void generateServiceWorker();
