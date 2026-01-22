import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { nitro } from 'nitro/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths';

const config = defineConfig({
	server: {
		port: 4000,
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
	optimizeDeps: {
		exclude: ['@electric-sql/pglite'],
	},
	plugins: [
		viteTsConfigPaths({
			projects: ['./tsconfig.json'],
		}),
		tailwindcss(),
		tanstackStart(),
		nitro(),
		viteReact(),
	],
	resolve: {
		alias: {
			$convex: path.resolve(__dirname, '../../convex'),
		},
		dedupe: ['yjs', 'lib0', 'y-protocols'],
	},
});

export default config;
