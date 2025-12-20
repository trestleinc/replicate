import eslint from "@eslint/js";
import convex from "@convex-dev/eslint-plugin";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base configs
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Stylistic formatting
  stylistic.configs.customize({
    indent: 2,
    quotes: "double",
    semi: true,
    jsx: true,
  }),

  // Convex-specific rules
  convex.configs.recommended,

  // Global settings
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

  // Rule overrides
  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@stylistic/max-len": ["error", { code: 100 }],
    },
  },

  // Ignore patterns
  {
    ignores: [
      "**/dist/**",
      "**/_generated/**",
      "**/*.d.ts",
      "**/routeTree.gen.ts",
    ],
  },

  // Test file overrides
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
