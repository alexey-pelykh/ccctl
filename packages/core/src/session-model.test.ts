// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  applyWorkerStatus,
  applyWorkerStatusFrame,
  createRegisteringSession,
  createSession,
  DEFAULT_HEARTBEAT_STALE_AFTER_MS,
  DEFAULT_REQUIRES_ACTION_DETAIL,
  isInputAwaited,
  isNonPromptingPermissionMode,
  isSessionStale,
  markSessionClosed,
  markSessionReady,
  MAX_REQUIRES_ACTION_DETAIL_LENGTH,
  NON_PROMPTING_PERMISSION_MODES,
  PERMISSION_MODES,
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

describe("isInputAwaited (AC: needs-you derives from requires_action worker-status only, #40)", () => {
  // Rule: requires-action worker status is the only source of needs-you.
  it("fires when the worker-status feed reports requires_action for a session", () => {
    const session = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "requires_action", detail: "Approve the edit?" }),
      T0 + 10,
    );
    expect(isInputAwaited(session.activity)).toBe(true);
  });

  it("is detail-agnostic — any requires_action fires it, including the default detail", () => {
    expect(isInputAwaited({ kind: "requires_action", detail: "Approve the edit?" })).toBe(true);
    expect(isInputAwaited({ kind: "requires_action", detail: DEFAULT_REQUIRES_ACTION_DETAIL })).toBe(true);
  });

  // Rule: output absence does not fire needs-you.
  it("does not fire for running or idle — the non-requires_action feed states", () => {
    expect(isInputAwaited({ kind: "running" })).toBe(false);
    expect(isInputAwaited({ kind: "idle" })).toBe(false);
  });

  it("does not fire for a freshly created session (born idle, no frame applied yet)", () => {
    expect(isInputAwaited(createSession("sess-1", "default", T0).activity)).toBe(false);
  });

  it("stream silence does not fire it — a stale session (heartbeat lapsed) is not input-awaited", () => {
    // Liveness is an ORTHOGONAL dimension: silence marks the session stale, never requires_action.
    const running = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "running" }),
      T0,
    );
    const later = T0 + DEFAULT_HEARTBEAT_STALE_AFTER_MS + 1;
    expect(isSessionStale(running, later)).toBe(true); // it IS silent/stale …
    expect(isInputAwaited(running.activity)).toBe(false); // … yet needs-you does not fire.
  });

  // Rule: a hook alone does not fire needs-you.
  it("a hook / progress frame alone does not fire it — a non-worker_status event never transitions activity", () => {
    const idle = createSession("sess-1", "default", T0);
    const hook: ControlFrame = { type: "control_event", subtype: "message", payload: { text: "progress" } };
    const afterHook = applyWorkerStatusFrame(idle, hook, T0 + 10);
    expect(afterHook).toBe(idle); // no-op: the hook cannot move the session.
    expect(isInputAwaited(afterHook.activity)).toBe(false);
  });

  it("a hook cannot resurrect the signal after requires_action was cleared by idle", () => {
    // requires_action → idle → hook: the hook must not re-raise the blocking signal.
    let session = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "requires_action", detail: "Approve?" }),
      T0 + 10,
    );
    expect(isInputAwaited(session.activity)).toBe(true);
    session = applyWorkerStatusFrame(session, statusFrame({ status: "idle" }), T0 + 20);
    expect(isInputAwaited(session.activity)).toBe(false);
    const hook: ControlFrame = { type: "control_event", subtype: "message", payload: {} };
    session = applyWorkerStatusFrame(session, hook, T0 + 30);
    expect(isInputAwaited(session.activity)).toBe(false);
  });
});

describe("session identity (AC: identity is the register-response session id)", () => {
  it("createSession keys the session on the given id", () => {
    expect(createSession("sess-1", "default", T0).id).toBe("sess-1");
  });

  it("a fresh session starts idle with the heartbeat clock at `now` (prompting mode ⇒ notifications not degraded)", () => {
    const session = createSession("sess-1", "default", T0);
    expect(session).toEqual({
      id: "sess-1",
      status: "connecting",
      activity: { kind: "idle" },
      notificationsDegraded: false,
      createdAt: T0,
      lastActivityAt: T0,
      lastHeartbeatAt: T0,
    });
  });

  // #33: a UC2 launch places its session in the registry BEFORE the worker has ever spoken — up on
  // its terminal, not yet checked in. It is a normal session in every other respect, so it lists,
  // and carries its life-long degraded marker from birth; only its lifecycle entry point differs.
  it("createRegisteringSession is a fresh session that enters the lifecycle at `registering`", () => {
    const session = createRegisteringSession("sess-1", "default", T0);
    expect(session).toEqual({
      id: "sess-1",
      status: "registering",
      activity: { kind: "idle" },
      notificationsDegraded: false,
      createdAt: T0,
      lastActivityAt: T0,
      lastHeartbeatAt: T0,
    });
  });

  it("createRegisteringSession derives the SAME life-long degraded marker as createSession", () => {
    // Identical birth, one step earlier in the lifecycle: the only difference is `status`.
    for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions"] as const) {
      const registering = createRegisteringSession("sess-1", mode, T0);
      const connecting = createSession("sess-1", mode, T0);
      expect(registering.notificationsDegraded).toBe(connecting.notificationsDegraded);
      expect({ ...registering, status: "connecting" }).toEqual(connecting);
    }
  });

  it("markSessionReady does not advance a `registering` session — it must register first", () => {
    // The forward-only guard (`connecting` → `ready`) already refuses it: a launched session that has
    // not checked in has no worker channel, so it cannot possibly be steerable.
    const registering = createRegisteringSession("sess-1", "default", T0);
    expect(markSessionReady(registering)).toBe(registering);
  });

  it("a session keys on the SessionCreateResponse.sessionId, not the ws_url (§2 identity)", () => {
    const response: SessionCreateResponse = {
      sessionId: "sess-from-create",
      wsUrl: "wss://127.0.0.1:8787/v1/sessions/sess-from-create/ws",
    };
    const session = createSession(response.sessionId, "default", T0);
    expect(session.id).toBe("sess-from-create");
    expect(session.createdAt).toBe(T0);
  });
});

describe("liveness / staleness (AC: missed-heartbeat window marks the session stale)", () => {
  const session = createSession("sess-1", "default", T0);

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
    const before = createSession("sess-1", "default", T0);
    const after = applyWorkerStatusFrame(before, statusFrame({ status: "running" }), T0 + 10);
    expect(after).not.toBe(before);
    expect(after.activity).toEqual({ kind: "running" });
    expect(after.lastActivityAt).toBe(T0 + 10);
    // The input is untouched (pure).
    expect(before.activity).toEqual({ kind: "idle" });
    expect(before.lastActivityAt).toBe(T0);
  });

  it("applyWorkerStatusFrame is a no-op (same reference) on a non-`worker_status` frame", () => {
    const before = createSession("sess-1", "default", T0);
    const other: ControlFrame = { type: "control_event", subtype: "message", payload: {} };
    expect(applyWorkerStatusFrame(before, other, T0 + 10)).toBe(before);
  });

  it("a transition on one session never mutates another session", () => {
    const a = createSession("sess-a", "default", T0);
    const b = createSession("sess-b", "default", T0);
    const bSnapshot = structuredClone(b);

    applyWorkerStatusFrame(a, statusFrame({ status: "requires_action", detail: "Approve?" }), T0 + 1);
    recordHeartbeat(a, T0 + 2);

    // b is byte-for-byte unchanged by any transition applied to a.
    expect(b).toEqual(bSnapshot);
  });

  it("transitions compose independently across the three orthogonal dimensions", () => {
    const s0 = createSession("sess-1", "default", T0);
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
    const before = createSession("sess-1", "default", T0);
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
    const ready = markSessionReady(createSession("sess-1", "default", T0));
    expect(markSessionReady(ready)).toBe(ready);
    // The forward-only guard also protects a future busy / closed / errored from being reset to ready.
    for (const status of ["busy", "closed", "errored"] as const) {
      const session = { ...createSession("sess-1", "default", T0), status };
      expect(markSessionReady(session)).toBe(session);
    }
  });

  it("markSessionClosed drives any LIVE status to the terminal `closed`, purely and status-only", () => {
    // The reverse leg of markSessionReady (#173): a live session torn down → `closed`.
    for (const status of ["connecting", "ready", "busy"] as const) {
      const before = { ...createSession("sess-1", "default", T0), status };
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
      const session = { ...createSession("sess-1", "default", T0), status };
      expect(markSessionClosed(session)).toBe(session);
    }
  });
});

// #39 AC4 (per-session half): "Classification is per-session … " — a frame applied to one
// session never moves another's. The frame-age half of AC4 is NOT enforced here: the wire
// carries no frame timestamp to order by, so applications are last-write-wins in the server's
// receipt order (see the note above `capturedRequiresActionDetail` in index.ts).
describe("per-session classification (#39 AC4: one session's frame never moves another's)", () => {
  it("applies each session's own frames independently, across both transitions", () => {
    const a = applyWorkerStatusFrame(
      createSession("sess-a", "default", T0),
      statusFrame({ status: "running" }),
      T0 + 100,
    );
    const b = createSession("sess-b", "default", T0);
    const bSnapshot = structuredClone(b);
    // Every transition on `a` — both legs — leaves `b` byte-for-byte untouched.
    applyWorkerStatusFrame(a, statusFrame({ status: "idle" }), T0 + 200);
    applyWorkerStatus(a, "requires_action", "Approve?", T0 + 300);
    expect(b).toEqual(bSnapshot);
    expect(a.activity).toEqual({ kind: "running" });
  });

  it("is last-write-wins in receipt order, so a later frame always lands", () => {
    // No frame-age guard: the wire has no timestamp, and a clock-derived guard could only
    // refuse frames it cannot prove are stale — silently dropping a `requires_action` is a
    // far worse failure than applying an out-of-order one.
    const running = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "running" }),
      T0 + 100,
    );
    const idle = applyWorkerStatusFrame(running, statusFrame({ status: "idle" }), T0 + 50);
    expect(idle.activity).toEqual({ kind: "idle" });
  });
});

// #39 Reachable-state expansion: folding the §5 leg into the model means `activity.detail` now
// holds an arbitrary WORKER-SUPPLIED string where it could previously only ever hold the fixed
// `DEFAULT_REQUIRES_ACTION_DETAIL`. It is a one-line label rendered into `ccctl attach`'s
// line-oriented session list and re-served on every `GET /api/sessions` poll, so it is
// normalized at this trust boundary — the one point it enters the model.
describe("requires_action detail normalization (#39: a worker-supplied detail is a bounded single line)", () => {
  const withDetail = (detail: string) =>
    applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "requires_action", detail }),
      T0 + 10,
    );

  it("flattens newlines so a detail cannot forge a row in a line-oriented list", () => {
    // `ccctl attach` prints one line per session; an unflattened newline lets a worker-supplied
    // detail render a session row that does not exist.
    const activity = withDetail("Approve?\n  99999999-9999-9999-9999-999999999999  [ready] idle");
    expect(activity.activity).toEqual({
      kind: "requires_action",
      detail: "Approve? 99999999-9999-9999-9999-999999999999 [ready] idle",
    });
    expect((activity.activity as { detail: string }).detail).not.toContain("\n");
  });

  it("strips ANSI/CSI escapes and other control characters (they repaint the operator's terminal)", () => {
    // "\u001b[2J\u001b[H" clears the screen and homes the cursor. Neutralizing the ESC that OPENS
    // the sequence is what disarms it — the "[2J" / "[H" left behind are inert literal text.
    // Each control character becomes a space, so "a\nb" reads "a b", never "ab".
    const { detail } = withDetail("\u001b[2J\u001b[HApprove\u0007 the  edit?").activity as { detail: string };
    expect(detail).toBe("[2J [HApprove the edit?");
    // No C0/C1 control character survives, so the operator's terminal cannot be repainted.
    const codes = Array.from(detail, (character) => character.codePointAt(0) ?? 0);
    expect(codes.some((code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f))).toBe(false);
  });

  it("clamps an over-long detail to MAX_REQUIRES_ACTION_DETAIL_LENGTH with an ellipsis", () => {
    // A 512KB detail is within the 1 MiB body cap and would otherwise be re-served on every poll.
    const { detail } = withDetail("A".repeat(500_000)).activity as { detail: string };
    expect(detail).toHaveLength(MAX_REQUIRES_ACTION_DETAIL_LENGTH);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("keeps a detail exactly at the cap unclamped (boundary is strict `>`)", () => {
    const exact = "A".repeat(MAX_REQUIRES_ACTION_DETAIL_LENGTH);
    expect((withDetail(exact).activity as { detail: string }).detail).toBe(exact);
  });

  it("clamps by CODE POINT, so an astral character is never split into a lone surrogate", () => {
    // Each emoji is ONE code point but TWO UTF-16 code units, so a code-unit clamp lands mid-pair
    // and emits an unpaired surrogate — not well-formed UTF-16, and a replacement glyph on the wire.
    const { detail } = withDetail("😀".repeat(250)).activity as { detail: string };
    expect(detail.isWellFormed()).toBe(true);
    expect(Array.from(detail)).toHaveLength(MAX_REQUIRES_ACTION_DETAIL_LENGTH);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("measures the cap in code points, not UTF-16 code units", () => {
    // 101 emoji is 202 code units but only 101 code points: under the cap, so it must pass through
    // WHOLE. A code-unit clamp would see 202 > 200 and truncate it mid-pair.
    const under = "😀".repeat(101);
    const { detail } = withDetail(under).activity as { detail: string };
    expect(detail).toBe(under);
    expect(detail.isWellFormed()).toBe(true);
  });

  it("drops zero-width format characters (a bidi override silently reorders the line)", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE reverses the rendering of everything after it; U+200B is an
    // invisible pad. Neither is content, and both survive a control-character filter (they are
    // category Cf, not C0/C1).
    const { detail } = withDetail("Approve\u202e\u200b the edit?").activity as { detail: string };
    expect(detail).toBe("Approve the edit?");
  });

  it("falls back to the default when a detail is only zero-width characters (non-empty ≠ displayable)", () => {
    expect(withDetail("\u200b\u202e\ufeff").activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
  });

  it("falls back to the default when a detail normalizes away to nothing", () => {
    // Control-characters-only is not a human-ready line; it must not surface as an empty label.
    expect(withDetail("\u001b\u0007\n\t ").activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
  });

  it("leaves an ordinary tool description untouched", () => {
    expect(withDetail("Approve the edit to packages/server/src/worker-channel.ts?").activity).toEqual({
      kind: "requires_action",
      detail: "Approve the edit to packages/server/src/worker-channel.ts?",
    });
  });
});

// #39 AC2: "A `requires_action` status classifies the session as requires_action AND captures
// the human-ready detail (the tool/action description) for the notification." Two legs report a
// status: the §5 events leg carries the RICH frame (`payload: { status, detail }`), the §4
// `PUT …/worker` gate carries a BARE status with no detail field at all. So a bare re-affirmation
// must not degrade a detail the rich leg already captured — otherwise the notification (#43)
// reads the generic default and AC2 is met only until the next status report.
describe("requires_action detail capture (#39 AC2: the session carries the human-ready action detail)", () => {
  const blocked = (detail?: string) =>
    applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame({ status: "requires_action", detail }),
      T0 + 10,
    );

  it("captures the rich detail the frame supplies", () => {
    expect(blocked("Approve the edit to src/index.ts?").activity).toEqual({
      kind: "requires_action",
      detail: "Approve the edit to src/index.ts?",
    });
  });

  it("RETAINS a captured detail when a BARE requires_action re-affirms it (the §4 gate carries none)", () => {
    const captured = blocked("Approve the edit to src/index.ts?");
    const reaffirmed = applyWorkerStatus(captured, "requires_action", undefined, T0 + 20);
    expect(reaffirmed.activity).toEqual({ kind: "requires_action", detail: "Approve the edit to src/index.ts?" });
    // It is a real application, not a refusal: the clock still advances.
    expect(reaffirmed.lastActivityAt).toBe(T0 + 20);
  });

  it("treats a BLANK detail as absent and retains the captured one (blank is not a statement)", () => {
    const captured = blocked("Approve the edit to src/index.ts?");
    expect(applyWorkerStatus(captured, "requires_action", "   ", T0 + 20).activity).toEqual({
      kind: "requires_action",
      detail: "Approve the edit to src/index.ts?",
    });
  });

  it("lets an explicit detail REPLACE a previously captured one", () => {
    const captured = blocked("Approve the edit to src/index.ts?");
    expect(applyWorkerStatus(captured, "requires_action", "Approve the shell command?", T0 + 20).activity).toEqual({
      kind: "requires_action",
      detail: "Approve the shell command?",
    });
  });

  it("DROPS the captured detail once the session leaves requires_action (the question it named is gone)", () => {
    const captured = blocked("Approve the edit to src/index.ts?");
    const idle = applyWorkerStatus(captured, "idle", undefined, T0 + 20);
    expect(idle.activity).toEqual({ kind: "idle" });
    // A later BARE requires_action starts from nothing again — it must not resurrect the
    // stale question the session already moved past.
    expect(applyWorkerStatus(idle, "requires_action", undefined, T0 + 30).activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
  });

  it("falls back to the default when nothing was ever captured", () => {
    expect(blocked().activity).toEqual({ kind: "requires_action", detail: DEFAULT_REQUIRES_ACTION_DETAIL });
  });
});

describe("isNonPromptingPermissionMode (AC: non-prompting modes → notifications degraded)", () => {
  it("classifies acceptEdits and bypassPermissions as non-prompting (they auto-proceed)", () => {
    expect(isNonPromptingPermissionMode("acceptEdits")).toBe(true);
    expect(isNonPromptingPermissionMode("bypassPermissions")).toBe(true);
  });

  it("classifies default and plan as prompting (default prompts per decision; plan blocks on plan approval)", () => {
    expect(isNonPromptingPermissionMode("default")).toBe(false);
    expect(isNonPromptingPermissionMode("plan")).toBe(false);
  });

  it("the non-prompting and prompting sets PARTITION every pinned permission mode", () => {
    // Every pinned mode is classified exactly once. A mode added to PERMISSION_MODES without
    // being triaged (prompting vs non-prompting) breaks this — catching classification drift.
    const nonPrompting = PERMISSION_MODES.filter((m) => isNonPromptingPermissionMode(m));
    const prompting = PERMISSION_MODES.filter((m) => !isNonPromptingPermissionMode(m));
    expect([...nonPrompting].sort()).toEqual([...NON_PROMPTING_PERMISSION_MODES].sort());
    expect(prompting).toEqual(["default", "plan"]);
    expect(nonPrompting.length + prompting.length).toBe(PERMISSION_MODES.length);
  });
});

describe("createSession notifications-degraded marker (AC: set at attach from the observed mode, life-long)", () => {
  it("marks a session created under a non-prompting mode notifications-degraded", () => {
    for (const mode of ["acceptEdits", "bypassPermissions"] as const) {
      expect(createSession("sess-np", mode, T0).notificationsDegraded).toBe(true);
    }
  });

  it("leaves a session created under a prompting mode NOT degraded — it carries no marker", () => {
    for (const mode of ["default", "plan"] as const) {
      expect(createSession("sess-p", mode, T0).notificationsDegraded).toBe(false);
    }
  });

  it("derives the marker for EVERY pinned mode from isNonPromptingPermissionMode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(createSession("sess-x", mode, T0).notificationsDegraded).toBe(isNonPromptingPermissionMode(mode));
    }
  });

  it("keeps the marker life-long: no transition clears a degraded session's marker", () => {
    // A non-prompting session marked at birth stays degraded through EVERY transition —
    // activity, heartbeat, ready, close — since a running session's mode cannot change and
    // each transition spreads the session forward unchanged on this axis.
    const born = createSession("sess-np", "bypassPermissions", T0);
    expect(born.notificationsDegraded).toBe(true);
    const running = applyWorkerStatusFrame(born, statusFrame({ status: "running" }), T0 + 1);
    const beaten = recordHeartbeat(running, T0 + 2);
    const ready = markSessionReady(beaten);
    const closed = markSessionClosed(ready);
    for (const s of [running, beaten, ready, closed]) {
      expect(s.notificationsDegraded).toBe(true);
    }
  });

  it("keeps a prompting session UNmarked through every transition", () => {
    const born = createSession("sess-p", "default", T0);
    const acted = applyWorkerStatusFrame(born, statusFrame({ status: "requires_action" }), T0 + 1);
    const ready = markSessionReady(acted);
    expect(born.notificationsDegraded).toBe(false);
    expect(ready.notificationsDegraded).toBe(false);
  });
});
