import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	build: {
		rollupOptions: {
			onwarn(warning, warn) {
				if (warning.code === 'CIRCULAR_DEPENDENCY' && warning.message.includes('node_modules')) {
					return;
				}
				warn(warning);
			},
		},
	},
	resolve: {
		dedupe: ['yjs', 'lib0', 'y-protocols'],
	},
	worker: {
		format: 'es',
	},
	optimizeDeps: {
		exclude: ['@electric-sql/pglite', '@trestleinc/replicate'],
	},
	ssr: {
		noExternal: [/^@trestleinc\/replicate/],
	},
});
