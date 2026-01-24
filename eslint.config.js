import js from '@eslint/js';
import ts from 'typescript-eslint';
import convexPlugin from '@convex-dev/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/.svelte-kit/**',
			'**/dist/**',
			'**/build/**',
			'**/_generated/**',
			// Svelte runes files need special handling - they use Svelte 5 runes
			// which ESLint parser doesn't fully understand
			'**/*.svelte.ts',
			'**/*.svelte.js',
		],
	},
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		// Allow CommonJS require() in config files
		files: ['**/*.config.js', '**/*.config.cjs'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
		},
	},

	// Convex-specific rules for convex/ directories
	...convexPlugin.configs.recommended,
];
