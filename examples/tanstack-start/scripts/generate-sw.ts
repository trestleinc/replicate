import { injectManifest } from "workbox-build";
import { resolve } from "node:path";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

const distClient = resolve(import.meta.dirname, "../.output/public");
const srcSw = resolve(import.meta.dirname, "../src/sw.ts");

async function generateServiceWorker() {
  // Check if .output/public exists
  if (!existsSync(distClient)) {
    console.error("Error: .output/public does not exist. Run `bun run build` first.");
    process.exit(1);
  }

  // Use Bun to transpile TypeScript to JavaScript
  console.log("Transpiling service worker...");
  const transpiled = await Bun.build({
    entrypoints: [srcSw],
    format: "esm",
    target: "browser",
    minify: false,
  });

  if (!transpiled.success) {
    console.error("Failed to transpile service worker:", transpiled.logs);
    process.exit(1);
  }

  // Get the transpiled content
  const swJsContent = await transpiled.outputs[0].text();

  // Write temporary JS file for workbox to inject into
  const tempSwPath = resolve(distClient, "sw-src.js");
  writeFileSync(tempSwPath, swJsContent);

  console.log("Generating service worker with workbox...");

  try {
    const { count, size, warnings } = await injectManifest({
      swSrc: tempSwPath,
      swDest: resolve(distClient, "sw.js"),
      globDirectory: distClient,
      globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
      // Don't precache these files
      globIgnores: ["sw-src.js", "sw.js"],
      // Increase file size limit for larger bundles
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
    });

    // Clean up temp file
    unlinkSync(tempSwPath);

    if (warnings.length > 0) {
      console.warn("Warnings:", warnings.join("\n"));
    }

    console.log(
      `✓ Service worker generated with ${count} files, totaling ${(size / 1024).toFixed(1)} KB`,
    );
  }
  catch (error) {
    console.error("Error generating service worker:", error);
    process.exit(1);
  }
}

generateServiceWorker();
