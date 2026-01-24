const { FlatCompat } = require('@eslint/compat');

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

module.exports = [
  ...compat.extends('expo'),
  ...compat.extends('prettier'),
  {
    ignores: [
      '**/node_modules/**',
      '**/.expo/**',
      '**/dist/**',
      '**/build/**',
      '**/_generated/**',
      '**/android/**',
      '**/ios/**',
    ],
  },
];
