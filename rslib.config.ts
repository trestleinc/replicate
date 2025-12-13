import { defineConfig } from '@rslib/core';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';

export default defineConfig({
  plugins: [pluginTypeCheck()],
  lib: [
    {
      // Shared types - types-only module safe for any environment
      id: 'shared',
      format: 'esm',
      syntax: 'es2022',
      dts: true,
      output: {
        distPath: {
          root: './dist',
        },
      },
      source: {
        entry: {
          shared: './src/shared/index.ts',
        },
      },
    },
    {
      // Client code - BUNDLED (default mode)
      // Single file entry bundles all imports into dist/index.js
      id: 'client',
      format: 'esm',
      syntax: 'es2022',
      dts: true,
      shims: {
        esm: {
          __dirname: true,
          __filename: true,
        },
      },
      output: {
        distPath: {
          root: './dist',
        },
        externals: [
          'yjs',
          '@tanstack/offline-transactions',
          '@tanstack/db',
          'convex/browser',
          'convex/server',
          'convex/values',
          '@logtape/logtape',
        ],
      },
      source: {
        entry: {
          index: './src/client/index.ts', // ← Simple file entry (bundled)
        },
      },
    },
    {
      // Server (Convex backend) - BUNDLED (default mode)
      id: 'server',
      format: 'esm',
      syntax: 'es2022',
      dts: true,
      shims: {
        esm: {
          __dirname: true,
          __filename: true,
        },
      },
      output: {
        distPath: {
          root: './dist',
        },
        externals: ['convex/server', 'convex/values'],
      },
      source: {
        entry: {
          server: './src/server/index.ts', // ← Exports all server utilities
        },
      },
    },
    {
      // Component - BUNDLELESS (special case to preserve directory structure)
      // Glob pattern entry preserves entire component/ directory including _generated/
      id: 'component',
      format: 'esm',
      bundle: false, // ← Only component uses bundleless mode
      outBase: './src', // ← Preserves component/ prefix in output
      dts: true,
      output: {
        distPath: {
          root: './dist',
        },
        externals: ['convex/server', 'convex/values'],
      },
      source: {
        entry: {
          'component/index': ['./src/component/**', './src/shared/**'], // Include shared for component imports
        },
      },
    },
  ],
  output: {
    target: 'node',
  },
});
