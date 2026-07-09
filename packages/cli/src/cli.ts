#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Executable entry for the `ccctl` binary. Kept thin: it only parses argv and
 * hands off to the command tree defined in `./index.ts`.
 */

import { buildProgram } from "./index.js";

buildProgram().parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
