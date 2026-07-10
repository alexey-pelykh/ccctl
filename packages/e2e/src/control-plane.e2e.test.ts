// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it } from "vitest";
import { CONTROL_PLANE_SCENARIO } from "./index.js";

// Placeholder end-to-end suite. The real test will:
//   1. launch a patched, headless Claude Code worker pointed at --sdk-url;
//   2. bring up @ccctl/server on loopback and connect a UI SSE client;
//   3. drive a prompt through the control channel; and
//   4. assert inference traffic still egresses to api.anthropic.com
//      (the control plane must not proxy or reroute model traffic).
describe.todo(`ccctl e2e: ${CONTROL_PLANE_SCENARIO.name}`, () => {
  it.todo("keeps inference on api.anthropic.com while steering via SSE");
});
