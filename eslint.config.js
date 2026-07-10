// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import headerPlugin from "@tony.ganchev/eslint-plugin-header";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    ignores: ["**/dist/"],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // A leading underscore marks a binding that is deliberately unused: a
      // parameter kept because it documents a contract (`startServer(_config)`,
      // `open(_local)`), or a caught error we intentionally swallow. Without
      // this the skeleton's typed stubs cannot express their own signatures.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.e2e.test.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Loose tooling config files: outside any tsconfig project. Skip
    // type-aware lint (imported by tooling, not part of compiled output).
    // The header rule below still applies.
    files: ["eslint.config.js", "**/*.config.ts", "**/scripts/**/*.{js,mjs,cjs,ts}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain JS root files lack @types/node — disable `no-undef` so Node
    // globals (console, process, …) don't trip the recommended ruleset.
    files: ["eslint.config.js", "**/scripts/**/*.{js,mjs,cjs}"],
    rules: {
      "no-undef": "off",
    },
  },
  {
    // Zero-build browser ES module: shipped as-is, so it belongs to no tsconfig
    // project — skip type-aware lint. Declaring the handful of Web APIs it uses
    // (rather than switching `no-undef` off) keeps typo'd globals an error.
    files: ["packages/web-ui/src/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        document: "readonly",
        EventSource: "readonly",
        fetch: "readonly",
      },
    },
  },
  {
    plugins: {
      header: headerPlugin,
    },
    rules: {
      "header/header": [
        "error",
        "line",
        [" SPDX-License-Identifier: AGPL-3.0-only", " Copyright (C) 2026 Oleksii PELYKH"],
      ],
    },
  },
);
