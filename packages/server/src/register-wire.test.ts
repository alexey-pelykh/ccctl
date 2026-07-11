// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { RegisterResponse } from "@ccctl/core";
import { toRegisterResponseWire } from "./register-wire.js";

// A fixed, credential-free RegisterResponse (core's camelCase model) and the
// EXACT snake_case bytes it must serialize to. Hardcoding the golden string —
// rather than deriving it from the input — is what makes this a drift sentinel:
// a renamed key, a reordered field, an extra property, or a reverted casing all
// change these bytes and fail closed (ADR-001; bridge-protocol §1). This pins
// the wire shape deterministically, complementing the live-endpoint contract
// test in index.test.ts.
const CORE_RESPONSE: RegisterResponse = {
  sessionId: "sess-1",
  wsUrl: "ws://127.0.0.1:8787/v1/code/sessions/sess-1/ws",
};
const GOLDEN_WIRE_JSON = '{"session_id":"sess-1","ws_url":"ws://127.0.0.1:8787/v1/code/sessions/sess-1/ws"}';

describe("toRegisterResponseWire — register-response wire DTO (ADR-001)", () => {
  it("serializes core's camelCase RegisterResponse to the exact snake_case wire bytes", () => {
    expect(JSON.stringify(toRegisterResponseWire(CORE_RESPONSE))).toBe(GOLDEN_WIRE_JSON);
  });

  it("emits exactly session_id + ws_url, in that order, and no camelCase key leaks", () => {
    const wire = toRegisterResponseWire(CORE_RESPONSE);
    // Key set AND order are pinned; a stray, missing, or renamed field fails closed.
    expect(Object.keys(wire)).toEqual(["session_id", "ws_url"]);
    // Core's internal casing must not reach the wire.
    expect(wire).not.toHaveProperty("sessionId");
    expect(wire).not.toHaveProperty("wsUrl");
  });

  it("maps each core field to its snake_case counterpart by value", () => {
    const wire = toRegisterResponseWire(CORE_RESPONSE);
    expect(wire.session_id).toBe(CORE_RESPONSE.sessionId);
    expect(wire.ws_url).toBe(CORE_RESPONSE.wsUrl);
  });
});
