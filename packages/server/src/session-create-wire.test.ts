// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { SessionCreateResponse } from "@ccctl/core";
import { toSessionCreateResponseWire } from "./session-create-wire.js";

// A fixed, credential-free SessionCreateResponse (core's camelCase model) and the
// EXACT snake_case bytes it must serialize to. Hardcoding the golden string — rather
// than deriving it from the input — is what makes this a drift sentinel: a renamed
// key, an extra property, a reverted casing, or a RESURRECTED `ws_url` all change
// these bytes and fail closed (ADR-001; bridge-protocol §2; issue #130 dropped
// `ws_url` — the SSE control path never reads one). This pins the wire shape
// deterministically, complementing the live-endpoint contract test in the §2
// session-create suite (environments-bridge.test.ts).
const CORE_RESPONSE: SessionCreateResponse = {
  sessionId: "sess-1",
};
const GOLDEN_WIRE_JSON = '{"session_id":"sess-1"}';

describe("toSessionCreateResponseWire — session-create response wire DTO (ADR-001)", () => {
  it("serializes core's camelCase SessionCreateResponse to the exact snake_case wire bytes", () => {
    expect(JSON.stringify(toSessionCreateResponseWire(CORE_RESPONSE))).toBe(GOLDEN_WIRE_JSON);
  });

  it("emits exactly session_id, and no camelCase key or resurrected ws_url leaks", () => {
    const wire = toSessionCreateResponseWire(CORE_RESPONSE);
    // Key set is pinned; a stray, missing, or renamed field fails closed.
    expect(Object.keys(wire)).toEqual(["session_id"]);
    // Core's internal casing must not reach the wire, and ws_url must stay dropped.
    expect(wire).not.toHaveProperty("sessionId");
    expect(wire).not.toHaveProperty("ws_url");
    expect(wire).not.toHaveProperty("wsUrl");
  });

  it("maps the core session id to its snake_case counterpart by value", () => {
    const wire = toSessionCreateResponseWire(CORE_RESPONSE);
    expect(wire.session_id).toBe(CORE_RESPONSE.sessionId);
  });
});
