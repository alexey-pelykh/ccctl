// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  applyWorkerStatusFrame,
  createSession,
  DEFAULT_HEARTBEAT_STALE_AFTER_MS,
  DEFAULT_REQUIRES_ACTION_DETAIL,
  isSessionStale,
  markSessionClosed,
  markSessionReady,
  recordHeartbeat,
  sessionActivityFromFrame,
  sessionLiveness,
  type ControlFrame,
  type SessionCreateResponse,
  type WorkerStatusEvent,
} from "./index.js";

// A fixed epoch so every liveness assertion is deterministic — the injectable
// `now` seam means no test ever reads a real clock.
const T0 = 1_000_000;

/** Build a well-formed `worker_status` frame with the given payload. */
function statusFrame(payload: WorkerStatusEvent["payload"]): WorkerStatusEvent {
  return { type: "control_event", subtype: "worker_status", payload };
}

describe("sessionActivityFromFrame (AC: tri-state derivation)", () => {
  it("derives `running` from a running frame", () => {
    expect(sessionActivityFromFrame(statusFrame({ status: "running" }))).toEqual({ kind: "running" });
  });

  it("derives `idle` from an idle frame", () => {
    expect(sessionActivityFromFrame(statusFrame({ status: "idle" }))).toEqual({ kind: "idle" });
  });

  it("derives `requires_action` and carries the frame's human-ready detail", () => {
    const activity = sessionActivityFromFrame(statusFrame({ status: "requires_action", detail: "Approve tool use?" }));
    expect(activity).toEqual({ kind: "requires_action", detail: "Approve tool use?" });
  });

  it("supplies the default detail when `requires_action` carries none", () => {
    expect(sessionActivityFromFrame(statusFrame({ status: "requires_action" }))).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
  });

  it("falls back to the default detail when the detail is blank", () => {
    const activity = sessionActivityFromFrame(statusFrame({ status: "requires_action", detail: "   " }));
    expect(activity).toEqual({ kind: "requires_action", detail: DEFAULT_REQUIRES_ACTION_DETAIL });
  });

  it("fails closed (null) on a non-`worker_status` frame", () => {
    const other: ControlFrame = { type: "control_event", subtype: "message", payload: {} };
    const request: ControlFrame = { type: "control_request", id: "r-1", subtype: "prompt" };
    expect(sessionActivityFromFrame(other)).toBeNull();
    expect(sessionActivityFromFrame(request)).toBeNull();
  });

  it("fails closed (null) on a `worker_status` frame with an unknown or absent status", () => {
    const unknown: ControlFrame = { type: "control_event", subtype: "worker_status", payload: { status: "paused" } };
    const noPayload: ControlFrame = { type: "control_event", subtype: "worker_status" };
    expect(sessionActivityFromFrame(unknown)).toBeNull();
    expect(sessionActivityFromFrame(noPayload)).toBeNull();
  });
});

describe("session identity (AC: identity is the register-response session id)", () => {
  it("createSession keys the session on the given id", () => {
    expect(createSession("sess-1", T0).id).toBe("sess-1");
  });

  it("a fresh session starts idle with the heartbeat clock at `now`", () => {
    const session = createSession("sess-1", T0);
    expect(session).toEqual({
      id: "sess-1",
      status: "connecting",
      activity: { kind: "idle" },
      createdAt: T0,
      lastActivityAt: T0,
      lastHeartbeatAt: T0,
    });
  });

  it("a session keys on the SessionCreateResponse.sessionId, not the ws_url (§2 identity)", () => {
    const response: SessionCreateResponse = {
      sessionId: "sess-from-create",
      wsUrl: "wss://127.0.0.1:8787/v1/sessions/sess-from-create/ws",
    };
    const session = createSession(response.sessionId, T0);
    expect(session.id).toBe("sess-from-create");
    expect(session.createdAt).toBe(T0);
  });
});

describe("liveness / staleness (AC: missed-heartbeat window marks the session stale)", () => {
  const session = createSession("sess-1", T0);

  it("is live while the heartbeat is fresh", () => {
    expect(isSessionStale(session, T0)).toBe(false);
    expect(isSessionStale(session, T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS - 1)).toBe(false);
    expect(sessionLiveness(session, T0)).toBe("live");
  });

  it("treats a gap exactly at the window as still live (boundary is strict `>`)", () => {
    expect(isSessionStale(session, T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS)).toBe(false);
    expect(sessionLiveness(session, T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS)).toBe("live");
  });

  it("is stale once the gap exceeds the window", () => {
    expect(isSessionStale(session, T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS + 1)).toBe(true);
    expect(sessionLiveness(session, T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS + 1)).toBe("stale");
  });

  it("honours an injected custom window", () => {
    expect(isSessionStale(session, T0 + 5000, 1000)).toBe(true);
    expect(isSessionStale(session, T0 + 500, 1000)).toBe(false);
  });

  it("recordHeartbeat refreshes liveness so a would-be-stale session is live again", () => {
    const later = T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS + 1;
    expect(isSessionStale(session, later)).toBe(true);
    const beaten = recordHeartbeat(session, later);
    expect(isSessionStale(beaten, later)).toBe(false);
    expect(beaten.lastHeartbeatAt).toBe(later);
  });
});

describe("explicit transitions (AC: per-session, one transition never mutates another)", () => {
  it("applyWorkerStatusFrame returns a NEW session with the derived activity and advanced lastActivityAt", () => {
    const before = createSession("sess-1", T0);
    const after = applyWorkerStatusFrame(before, statusFrame({ status: "running" }), T0 + 10);
    expect(after).not.toBe(before);
    expect(after.activity).toEqual({ kind: "running" });
    expect(after.lastActivityAt).toBe(T0 + 10);
    // The input is untouched (pure).
    expect(before.activity).toEqual({ kind: "idle" });
    expect(before.lastActivityAt).toBe(T0);
  });

  it("applyWorkerStatusFrame is a no-op (same reference) on a non-`worker_status` frame", () => {
    const before = createSession("sess-1", T0);
    const other: ControlFrame = { type: "control_event", subtype: "message", payload: {} };
    expect(applyWorkerStatusFrame(before, other, T0 + 10)).toBe(before);
  });

  it("a transition on one session never mutates another session", () => {
    const a = createSession("sess-a", T0);
    const b = createSession("sess-b", T0);
    const bSnapshot = structuredClone(b);

    applyWorkerStatusFrame(a, statusFrame({ status: "requires_action", detail: "Approve?" }), T0 + 1);
    recordHeartbeat(a, T0 + 2);

    // b is byte-for-byte unchanged by any transition applied to a.
    expect(b).toEqual(bSnapshot);
  });

  it("transitions compose independently across the three orthogonal dimensions", () => {
    const s0 = createSession("sess-1", T0);
    const s1 = applyWorkerStatusFrame(s0, statusFrame({ status: "running" }), T0 + 10);
    const s2 = recordHeartbeat(s1, T0 + 20);
    // Activity from the frame, liveness from the heartbeat, lifecycle untouched.
    expect(s2.activity).toEqual({ kind: "running" });
    expect(s2.lastHeartbeatAt).toBe(T0 + 20);
    expect(s2.lastActivityAt).toBe(T0 + 10);
    expect(s2.status).toBe("connecting");
    expect(s2.id).toBe("sess-1");
  });

  it("markSessionReady advances a fresh `connecting` session to `ready`, purely and status-only", () => {
    const before = createSession("sess-1", T0);
    const after = markSessionReady(before);
    expect(after).not.toBe(before);
    expect(after.status).toBe("ready");
    // Only `status` moves — the orthogonal activity / liveness / timing fields are untouched.
    expect(after).toEqual({ ...before, status: "ready" });
    // The input is untouched (pure).
    expect(before.status).toBe("connecting");
  });

  it("markSessionReady is a no-op (same reference) on any non-`connecting` status", () => {
    // Already `ready` (e.g. a downstream re-attach) → returned unchanged, never re-clobbered.
    const ready = markSessionReady(createSession("sess-1", T0));
    expect(markSessionReady(ready)).toBe(ready);
    // The forward-only guard also protects a future busy / closed / errored from being reset to ready.
    for (const status of ["busy", "closed", "errored"] as const) {
      const session = { ...createSession("sess-1", T0), status };
      expect(markSessionReady(session)).toBe(session);
    }
  });

  it("markSessionClosed drives any LIVE status to the terminal `closed`, purely and status-only", () => {
    // The reverse leg of markSessionReady (#173): a live session torn down → `closed`.
    for (const status of ["connecting", "ready", "busy"] as const) {
      const before = { ...createSession("sess-1", T0), status };
      const after = markSessionClosed(before);
      expect(after).not.toBe(before);
      expect(after.status).toBe("closed");
      // Only `status` moves — the orthogonal activity / liveness / timing fields are untouched.
      expect(after).toEqual({ ...before, status: "closed" });
      // The input is untouched (pure).
      expect(before.status).toBe(status);
    }
  });

  it("markSessionClosed is a no-op (same reference) on an already-terminal status", () => {
    // A terminal state never moves: re-closing is a no-op and a distinct `errored` is never
    // clobbered to `closed`.
    for (const status of ["closed", "errored"] as const) {
      const session = { ...createSession("sess-1", T0), status };
      expect(markSessionClosed(session)).toBe(session);
    }
  });
});
