// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  assertEnvironmentRegisterResponseWire,
  assertSessionCreateResponseWire,
  assertWorkPollResponseWire,
} from "./bridge-wire-conformance.js";

// Unit coverage of the wire-conformance oracle's PURE per-leg shape assertions (#124).
// Each pins the current environments-bridge flow's snake_case response face INDEPENDENTLY
// of the server's serializer, so these specs pin BOTH directions — the assertion ACCEPTS
// the pinned shape and, crucially, REJECTS a camelCase / reordered / drifted shape — so a
// conformance run cannot silently agree with a wrong contract (the Self-Confirming Mock
// gap). Exercised live against the real server in `wire-conformance.e2e.test.ts`; driven
// directly here so the shape gate is verified on every `test` run without a live server.

describe("assertEnvironmentRegisterResponseWire — §1 { environment_id, work_poll_token }", () => {
  const PINNED = JSON.stringify({ environment_id: "env-1", work_poll_token: "tok-1" });

  it("accepts the pinned snake_case wire body and returns it typed", () => {
    const wire = assertEnvironmentRegisterResponseWire(PINNED);
    expect(wire.environment_id).toBe("env-1");
    expect(wire.work_poll_token).toBe("tok-1");
  });

  it("rejects the camelCase shape — the Self-Confirming Mock a wrong casing would be", () => {
    const camel = JSON.stringify({ environmentId: "env-1", workPollToken: "tok-1" });
    expect(() => assertEnvironmentRegisterResponseWire(camel)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a reordered key set (key ORDER is pinned)", () => {
    const reordered = `{"work_poll_token":"tok-1","environment_id":"env-1"}`;
    expect(() => assertEnvironmentRegisterResponseWire(reordered)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a stray extra key and a missing key", () => {
    const extra = JSON.stringify({ environment_id: "env-1", work_poll_token: "tok-1", extra: "nope" });
    expect(() => assertEnvironmentRegisterResponseWire(extra)).toThrow(/does not match the pinned contract/);
    const missing = JSON.stringify({ environment_id: "env-1" });
    expect(() => assertEnvironmentRegisterResponseWire(missing)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a non-string or empty field value", () => {
    expect(() =>
      assertEnvironmentRegisterResponseWire(JSON.stringify({ environment_id: "", work_poll_token: "t" })),
    ).toThrow(/must be a non-empty string/);
    expect(() =>
      assertEnvironmentRegisterResponseWire(JSON.stringify({ environment_id: "e", work_poll_token: 1 })),
    ).toThrow(/must be a non-empty string/);
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => assertEnvironmentRegisterResponseWire("not json")).toThrow(/not valid JSON/);
    expect(() => assertEnvironmentRegisterResponseWire("[]")).toThrow(/not a JSON object/);
    expect(() => assertEnvironmentRegisterResponseWire("null")).toThrow(/not a JSON object/);
  });
});

describe("assertSessionCreateResponseWire — §2 { session_id, ws_url } (ADR-001)", () => {
  const SESSION_ID = "sess-1";
  const WS_URL = "ws://127.0.0.1:8787/v1/sessions/sess-1/ws";
  const PINNED = JSON.stringify({ session_id: SESSION_ID, ws_url: WS_URL });

  it("accepts the pinned snake_case wire body and returns it typed", () => {
    const wire = assertSessionCreateResponseWire(PINNED);
    expect(wire.session_id).toBe(SESSION_ID);
    expect(wire.ws_url).toBe(WS_URL);
  });

  it("rejects the camelCase shape", () => {
    const camel = JSON.stringify({ sessionId: SESSION_ID, wsUrl: WS_URL });
    expect(() => assertSessionCreateResponseWire(camel)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a reordered, extra, or missing key", () => {
    expect(() => assertSessionCreateResponseWire(`{"ws_url":"${WS_URL}","session_id":"${SESSION_ID}"}`)).toThrow(
      /does not match the pinned contract/,
    );
    expect(() =>
      assertSessionCreateResponseWire(JSON.stringify({ session_id: SESSION_ID, ws_url: WS_URL, extra: "nope" })),
    ).toThrow(/does not match the pinned contract/);
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: SESSION_ID }))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects a non-string or empty field value", () => {
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: "", ws_url: WS_URL }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: 1, ws_url: WS_URL }))).toThrow(
      /must be a non-empty string/,
    );
  });
});

describe("assertWorkPollResponseWire — §3 { work: WorkItem[] }", () => {
  it("accepts an empty batch", () => {
    expect(assertWorkPollResponseWire(JSON.stringify({ work: [] }))).toEqual([]);
  });

  it("accepts a batch of well-formed work items (with and without payload)", () => {
    const items = [
      { kind: "create_session", id: "w1", payload: { session_id: "s1" } },
      { kind: "user_turn", id: "w2" },
    ];
    expect(assertWorkPollResponseWire(JSON.stringify({ work: items }))).toEqual(items);
  });

  it("rejects a wrong envelope key or an extra key (envelope shape is pinned)", () => {
    expect(() => assertWorkPollResponseWire(JSON.stringify({ items: [] }))).toThrow(
      /does not match the pinned contract/,
    );
    expect(() => assertWorkPollResponseWire(JSON.stringify({ work: [], extra: 1 }))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects a `work` field that is not an array", () => {
    expect(() => assertWorkPollResponseWire(JSON.stringify({ work: { id: "w1" } }))).toThrow(/is not an array/);
  });

  it("rejects a drifted work item (unknown kind, missing id, malformed payload) — fail closed", () => {
    expect(() => assertWorkPollResponseWire(JSON.stringify({ work: [{ kind: "bogus", id: "w1" }] }))).toThrow(
      /not a well-formed WorkItem/,
    );
    expect(() => assertWorkPollResponseWire(JSON.stringify({ work: [{ kind: "steer" }] }))).toThrow(
      /not a well-formed WorkItem/,
    );
    expect(() =>
      assertWorkPollResponseWire(JSON.stringify({ work: [{ kind: "user_turn", id: "w1", payload: [] }] })),
    ).toThrow(/not a well-formed WorkItem/);
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => assertWorkPollResponseWire("not json")).toThrow(/not valid JSON/);
    expect(() => assertWorkPollResponseWire("[]")).toThrow(/not a JSON object/);
  });
});
