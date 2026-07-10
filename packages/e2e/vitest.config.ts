// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
    test: {
        // Default (unit) run for @ccctl/e2e. The end-to-end specs (*.e2e.test.ts)
        // run separately via `test:e2e` (vitest.e2e.config.ts) because they need a
        // live patched worker + api.anthropic.com. Keep them out of the plain
        // `test` run so `turbo test` stays green without that environment.
        exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
    },
});
