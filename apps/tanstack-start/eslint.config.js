import rootConfig from '../../eslint.config.js';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
	...rootConfig,

	reactPlugin.configs.flat.recommended,
	reactPlugin.configs.flat['jsx-runtime'],

	{
		plugins: {
			'react-hooks': reactHooks,
		},
		rules: {
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
		},
		settings: {
			react: {
				version: 'detect',
			},
		},
	},

	{
		ignores: [
			'**/dist/**',
			'**/dev-dist/**',
			'**/.output/**',
			'**/_generated/**',
			'**/*.d.ts',
			'**/routeTree.gen.ts',
		],
	},
];
