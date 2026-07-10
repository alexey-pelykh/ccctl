// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same oxc/tsconfig opt-out as packages/core/vitest.config.ts. The e2e specs
  // (src/*.e2e.test.ts) are excluded from the package tsconfig — tests are not
  // part of the compiled/typechecked project graph. vite's oxc transformer
  // otherwise walks up, finds that tsconfig, sees the file is excluded, and fails
  // with "Tsconfig not found". The runner only strips types, so it needs no
  // project options; correctness is enforced by `typecheck` over the non-test
  // sources.
  oxc: {
    tsconfig: false,
  },
  test: {
    include: ["src/**/*.e2e.test.ts"],
    // E2E hits a real (patched) worker + api.anthropic.com; keep it serial.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
