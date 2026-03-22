import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const vitestGlobals = {
  afterEach: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  vi: "readonly",
};

const cypressGlobals = {
  Cypress: "readonly",
  cy: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  beforeEach: "readonly",
};

export default defineConfig([
  globalIgnores(["dist", "coverage", "cypress/videos", "cypress/screenshots"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...vitestGlobals,
      },
    },
  },
  {
    files: ["cypress/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...cypressGlobals,
      },
    },
  },
]);
