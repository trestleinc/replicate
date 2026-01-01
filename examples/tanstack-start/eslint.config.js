import eslint from "@eslint/js";
import convex from "@convex-dev/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
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

  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat["jsx-runtime"],

  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

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
    settings: {
      react: {
        version: "detect",
      },
    },
  },

  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@stylistic/max-len": ["error", { code: 100 }],
    },
  },

  {
    ignores: [
      "**/dist/**",
      "**/dev-dist/**",
      "**/_generated/**",
      "**/*.d.ts",
      "**/routeTree.gen.ts",
      "**/node_modules/**",
    ],
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["scripts/**"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["src/components/ui/**"],
    rules: {
      "react/prop-types": "off",
    },
  },
);
