import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { nitro } from 'nitro/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths';

const config = defineConfig({
	envDir: path.resolve(__dirname, '../..'),
	envPrefix: ['VITE_', 'PUBLIC_'],
	server: {
		port: 4000,
	},
	worker: {
		format: 'es',
	},
	optimizeDeps: {
		exclude: ['@electric-sql/pglite', '@trestleinc/replicate'],
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
	ssr: {
		noExternal: [/^@trestleinc\/replicate/],
	},
});

export default config;
