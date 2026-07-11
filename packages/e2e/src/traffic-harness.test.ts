// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { toRegisterResponseWire } from "@ccctl/server";
import { assertRegisterResponseWire } from "./traffic-harness.js";

// `assertRegisterResponseWire` is the fidelity gate #109 adds to the control leg:
// the register response the harness observes must be the snake_case
// `{session_id, ws_url}` wire shape PINNED by #108 / ADR-001. These specs pin BOTH
// directions — it ACCEPTS the pinned shape and, crucially, REJECTS a camelCase (or
// otherwise re-guessed) shape — so the assertion cannot silently agree with a wrong
// casing (the Self-Confirming Mock gap the issue exists to close). The valid fixture
// is itself built through the pinned mapper, so the test references the contract
// rather than re-transcribing it.

const SESSION_ID = "sess-1";
const WS_URL = "ws://127.0.0.1:8787/v1/code/sessions/sess-1/ws";
const PINNED_BODY = JSON.stringify(toRegisterResponseWire({ sessionId: SESSION_ID, wsUrl: WS_URL }));

describe("assertRegisterResponseWire — register→worker wire fidelity (#108 / ADR-001)", () => {
  it("accepts the pinned snake_case wire body and returns it typed", () => {
    const wire = assertRegisterResponseWire(PINNED_BODY);
    expect(wire.session_id).toBe(SESSION_ID);
    expect(wire.ws_url).toBe(WS_URL);
  });

  it("rejects the camelCase shape — the Self-Confirming Mock a wrong casing would be", () => {
    const camel = JSON.stringify({ sessionId: SESSION_ID, wsUrl: WS_URL });
    expect(() => assertRegisterResponseWire(camel)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a reordered key set (key ORDER is pinned)", () => {
    const reordered = `{"ws_url":"${WS_URL}","session_id":"${SESSION_ID}"}`;
    expect(() => assertRegisterResponseWire(reordered)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a stray extra key", () => {
    const extra = JSON.stringify({ session_id: SESSION_ID, ws_url: WS_URL, extra: "nope" });
    expect(() => assertRegisterResponseWire(extra)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a missing key", () => {
    const missing = JSON.stringify({ session_id: SESSION_ID });
    expect(() => assertRegisterResponseWire(missing)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a non-string or empty field value", () => {
    expect(() => assertRegisterResponseWire(JSON.stringify({ session_id: "", ws_url: WS_URL }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertRegisterResponseWire(JSON.stringify({ session_id: 1, ws_url: WS_URL }))).toThrow(
      /must be a non-empty string/,
    );
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => assertRegisterResponseWire("not json at all")).toThrow(/not valid JSON/);
    expect(() => assertRegisterResponseWire("[]")).toThrow(/not a JSON object/);
    expect(() => assertRegisterResponseWire("null")).toThrow(/not a JSON object/);
  });
});
