import eslint from "@eslint/js";
import convex from "@convex-dev/eslint-plugin";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  stylistic.configs.customize({
    indent: 2,
    quotes: "double",
    semi: true,
    jsx: true,
  }),

  convex.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@stylistic/max-len": ["error", { code: 100 }],
    },
  },

  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/_generated/**",
      "**/*.d.ts",
      "**/routeTree.gen.ts",
      "**/coverage/**",
      "**/illustrations/**",
      "**/node_modules/**",
      "*.config.js",
      "*.config.ts",
      // Build artifacts
      "**/.svelte-kit/**",
      "**/.output/**",
      // Config files in examples
      "**/babel.config.js",
      "**/metro.config.js",
      "**/postcss.config.mjs",
      "**/prettier.config.js",
      "**/svelte.config.js",
      "**/examples/**/eslint.config.js",
      // SvelteKit service worker (uses different tsconfig)
      "**/service-worker.ts",
    ],
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["src/component/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["examples/**/*.ts", "examples/**/*.tsx"],
    rules: {
      "no-console": "off",
      "@stylistic/arrow-parens": "off",
      "@stylistic/comma-dangle": "off",
      "@stylistic/brace-style": "off",
      "@stylistic/multiline-ternary": "off",
      "@stylistic/max-len": "off",
      "@stylistic/jsx-wrap-multilines": "off",
      "@stylistic/operator-linebreak": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
);
