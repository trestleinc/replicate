import rootConfig from '../../eslint.config.js';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

export default [
	...rootConfig,
	...svelte.configs['flat/recommended'],
	...svelte.configs['flat/prettier'],
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig,
			},
		},
		rules: {
			// Allow unused vars prefixed with underscore (for intentional destructuring)
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
		},
	},
	// Components using base prefix for dynamic paths (like apps/repl pattern)
	{
		files: ['**/components/ui/button/button.svelte', '**/lib/components/ui/button/button.svelte'],
		rules: {
			'svelte/no-navigation-without-resolve': 'off',
		},
	},
];
