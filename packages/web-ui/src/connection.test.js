// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import { LIVE, RECONNECTING, OFFLINE, connectionHealth } from "./connection.js";

describe("connection-health verdicts", () => {
  it("names exactly the three states the indicator shows (#75 AC1)", () => {
    expect([LIVE, RECONNECTING, OFFLINE]).toEqual(["live", "reconnecting", "offline"]);
  });
});

describe("connectionHealth", () => {
  it("is LIVE when the heartbeat is OK and the stream is open or not in use", () => {
    // Poll (the always-on session-list heartbeat) confirmed reachable; stream open → live.
    expect(connectionHealth({ poll: "ok", stream: "open" })).toBe(LIVE);
    // No session selected (stream idle): the heartbeat alone confirms the link is live.
    expect(connectionHealth({ poll: "ok", stream: "idle" })).toBe(LIVE);
  });

  it("is RECONNECTING while a leg is (re)establishing, even though the server is reachable", () => {
    // Heartbeat OK but the downstream SSE is opening or auto-reconnecting → degraded, not live.
    expect(connectionHealth({ poll: "ok", stream: "connecting" })).toBe(RECONNECTING);
    expect(connectionHealth({ poll: "ok", stream: "reconnecting" })).toBe(RECONNECTING);
  });

  it("is RECONNECTING before the first heartbeat settles (initial connect)", () => {
    // Nothing confirmed yet: establishing, not confirmed-live and not declared-down.
    expect(connectionHealth({ poll: "pending", stream: "idle" })).toBe(RECONNECTING);
    expect(connectionHealth({ poll: "pending", stream: "connecting" })).toBe(RECONNECTING);
  });

  it("is OFFLINE when the heartbeat fails — the poll is the authority on the link (#75 AC2)", () => {
    expect(connectionHealth({ poll: "failed", stream: "idle" })).toBe(OFFLINE);
    // A failed heartbeat means the request path (which steering needs) is down: offline wins
    // even over a still-open downstream handle — the operator cannot actually reach the server.
    expect(connectionHealth({ poll: "failed", stream: "open" })).toBe(OFFLINE);
    expect(connectionHealth({ poll: "failed", stream: "reconnecting" })).toBe(OFFLINE);
  });

  it("reads only the transport legs, never a session's worker status (#75 AC2)", () => {
    // A worker-activity field (running / requires_action / idle) must not move the verdict —
    // this indicator is about the phone↔server transport, not what the worker is doing.
    const base = { poll: "ok", stream: "open" };
    expect(connectionHealth({ ...base, activity: { kind: "requires_action" } })).toBe(LIVE);
    expect(connectionHealth({ ...base, activity: { kind: "running" } })).toBe(LIVE);
    expect(connectionHealth({ poll: "failed", stream: "open", activity: { kind: "running" } })).toBe(OFFLINE);
  });

  it("defends unknown / absent legs without throwing — an unknown poll is the safe middle, an unknown stream never a false downgrade", () => {
    // An unconfirmed / unknown poll is uncertain — not live, not offline.
    expect(connectionHealth({ poll: "weird", stream: "open" })).toBe(RECONNECTING);
    expect(connectionHealth({})).toBe(RECONNECTING);
    // The stream degrades only on an explicit connecting / reconnecting; any other value
    // (including unknown) leaves the poll's verdict standing, so it never invents a downgrade.
    expect(connectionHealth({ poll: "ok", stream: "weird" })).toBe(LIVE);
  });
});
