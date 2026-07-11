// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Unit tests live in `src/*.test.ts`, which the package tsconfig deliberately
  // excludes — tests are not part of the compiled/typechecked project graph
  // (see tsconfig.json + eslint's disableTypeChecked for test files). vite's oxc
  // transformer otherwise walks up, finds that tsconfig, sees the test file is
  // excluded, and fails with "Tsconfig not found". Disabling on-disk tsconfig
  // resolution for the transform sidesteps that: the runner only strips types,
  // so it needs no project options, and correctness is enforced by `typecheck`
  // over the non-test sources plus this suite. (Same opt-out as packages/server.)
  oxc: {
    tsconfig: false,
  },
});
