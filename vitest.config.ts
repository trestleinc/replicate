import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      // E2E tests run in edge-runtime (Convex functions)
      ['src/test/e2e/**', 'edge-runtime'],
      // Unit + Integration tests run in jsdom (browser simulation)
      ['src/test/unit/**', 'jsdom'],
      ['src/test/integration/**', 'jsdom'],
    ],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/test/**/*.test.ts'],
    server: { deps: { inline: ['convex-test'] } },
  },
  resolve: {
    alias: {
      $: resolve(__dirname, './src'),
    },
  },
});
