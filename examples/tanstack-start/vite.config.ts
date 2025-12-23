import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
import { VitePWA } from "vite-plugin-pwa";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  server: {
    port: 4000,
  },
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
    // VitePWA only generates manifest.webmanifest
    // Service worker is generated post-build via scripts/generate-sw.ts
    VitePWA({
      registerType: "prompt",
      injectRegister: false, // We use useRegisterSW manually in ReloadPrompt.tsx
      includeAssets: ["favicon.ico", "favicon.svg", "robots.txt"],
      manifest: {
        name: "Interval",
        short_name: "Interval",
        description: "Offline-first task tracker with real-time sync",
        theme_color: "#000000",
        background_color: "#ffffff",
        display: "standalone",
        icons: [
          {
            src: "logo192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "logo512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      devOptions: {
        enabled: false,
        type: "module",
        suppressWarnings: true,
      },
    }),
  ],
  resolve: {
    dedupe: ["yjs"],
  },
});

export default config;
