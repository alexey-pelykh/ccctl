// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    // E2E hits a real (patched) worker + api.anthropic.com; keep it serial.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
