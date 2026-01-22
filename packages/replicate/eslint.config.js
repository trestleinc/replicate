import js from '@eslint/js';
import ts from 'typescript-eslint';
import convexPlugin from '@convex-dev/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
	{ ignores: ['**/node_modules/**', '**/dist/**', '**/_generated/**'] },
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: { ...globals.node, ...globals.browser } },
	},
	{
		files: ['**/*.ts'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	// Convex component rules
	...convexPlugin.configs.recommended,
];
