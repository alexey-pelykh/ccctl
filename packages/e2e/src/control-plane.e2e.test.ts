// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it } from "vitest";
import { CONTROL_PLANE_SCENARIO } from "./index.js";

// Placeholder end-to-end suite. The real test will:
//   1. launch a patched, headless Claude Code worker pointed at --sdk-url;
//   2. bring up @ccctl/server on loopback and connect a UI SSE client;
//   3. drive a prompt through the control channel; and
//   4. assert inference traffic still egresses to api.anthropic.com
//      (the control plane must not proxy or reroute model traffic).
//
// Step 4 — the load-bearing inference-untouched assertion — already has a
// standalone skeleton in `inference-untouched.e2e.test.ts` (issue #18): it
// grounds the guarantee in real, receiver-observed connections against the real
// server + a loopback api.anthropic.com stand-in. This suite stays a placeholder
// for the full patched-worker → SSE happy path (steps 1-3), which lands
// credentialed in a later wave.
describe.todo(`ccctl e2e: ${CONTROL_PLANE_SCENARIO.name}`, () => {
  it.todo("keeps inference on api.anthropic.com while steering via SSE");
});
