// SPDX-License-Identifier: AGPL-3.0-or-later
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
    ignores: ["**/dist/", "packages/web-ui/src/"],
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
    plugins: {
      header: headerPlugin,
    },
    rules: {
      "header/header": [
        "error",
        "line",
        [" SPDX-License-Identifier: AGPL-3.0-or-later", " Copyright (C) 2026 Oleksii PELYKH"],
      ],
    },
  },
);
