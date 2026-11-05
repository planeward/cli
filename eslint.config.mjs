import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

const tsRules = {
  ...tseslint.configs.recommended.rules,
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      args: "none",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_|^err|^error",
      ignoreRestSiblings: true,
    },
  ],
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-empty-object-type": "off",
};

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ["node_modules/**", "dist/**", "*.js", "*.mjs"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: tsRules,
  },
  // Emulator host UI (React, own tsconfig with JSX).
  {
    files: ["src/emulator/ui/**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        project: "./src/emulator/ui/tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tsRules,
      ...reactHooks.configs["recommended-latest"].rules,
    },
  },
  prettierConfig,
];
