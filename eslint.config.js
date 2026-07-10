// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { builtinModules } from "node:module";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import headerPlugin from "@tony.ganchev/eslint-plugin-header";

// `@ccctl/core` is the runtime-agnostic protocol layer (CORE-C-001): a Node
// builtin imported there would couple the wire contract to one runtime and make
// a later Bun revisit costly. The message below is shown at every offending
// import.
const RUNTIME_AGNOSTIC_MESSAGE =
  "@ccctl/core is the runtime-agnostic protocol layer — no Node builtins (fs, net, node:*, …). Keep it pure TypeScript so a later Bun revisit stays ~0-cost.";

// `@ccctl/core` is the single dependency hub (CORE-I-001): the siblings
// (server / web-ui / tunnel-adapters / cli / e2e) depend on core; core depends
// on none of them. A core → sibling import inverts the hub and opens a cycle.
// The message below is shown at every offending import.
const HUB_MESSAGE =
  "@ccctl/core is the dependency hub — it must not import a sibling @ccctl/* package (server, web-ui, tunnel-adapters, cli, e2e). Siblings depend on core, never the reverse.";

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
    // What `@ccctl/core` may import — two constraints share one scope:
    //
    // 1. Runtime-agnostic (CORE-C-001): forbid every Node builtin import. The
    //    bare specifiers (`fs`, `net`, …) are enumerated from Node's own
    //    `builtinModules` so the ban can't rot as the stdlib grows; the `^node:`
    //    pattern covers the prefixed form (`node:fs`, `node:test`,
    //    `node:fs/promises`, …). Ambient Node globals are separately denied by
    //    `"types": []` in packages/core/tsconfig.json — together they keep the
    //    layer pure.
    // 2. Dependency hub (CORE-I-001): forbid importing a sibling `@ccctl/*`
    //    package so core stays the hub everything else depends on. The
    //    `^@ccctl/(?!core($|/))` pattern bans every workspace specifier except
    //    `@ccctl/core` itself (subpaths included), so a newly-added sibling is
    //    covered with no edit here; the relative pattern catches the filesystem
    //    escape form (`../../server/…`) that climbs out of packages/core into a
    //    sibling. `patterns` catches `import type` too.
    //
    // Both live in ONE `no-restricted-imports` rule on purpose: under flat
    // config a second block setting this rule would REPLACE (not merge) this
    // one, silently dropping whichever ban it omitted.
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((name) => !name.startsWith("node:"))
            .map((name) => ({ name, message: RUNTIME_AGNOSTIC_MESSAGE })),
          patterns: [
            { regex: "^node:", message: RUNTIME_AGNOSTIC_MESSAGE },
            { regex: "^@ccctl/(?!core($|/))", message: HUB_MESSAGE },
            {
              regex: "(\\.\\./)+(packages/)?(cli|e2e|server|tunnel-adapters|web-ui)($|/)",
              message: HUB_MESSAGE,
            },
          ],
        },
      ],
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
