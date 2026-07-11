// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  // Same oxc/tsconfig opt-out as packages/core + packages/server: the unit specs
  // (`src/*.test.ts`) are excluded from the package tsconfig, so vite's oxc
  // transformer would otherwise walk up, find that tsconfig, see the file
  // excluded, and fail with "Tsconfig not found". The runner only strips types;
  // correctness is enforced by `typecheck` over the non-test sources.
  oxc: {
    tsconfig: false,
  },
  test: {
    // Default (unit) run for @ccctl/e2e. The end-to-end specs (*.e2e.test.ts)
    // run separately via `test:e2e` (vitest.e2e.config.ts) because they need a
    // live patched worker + api.anthropic.com. Keep them out of the plain
    // `test` run so `turbo test` stays green without that environment.
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
