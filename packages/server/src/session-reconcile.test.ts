// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { createRegisteringSession, createSession, type Session } from "@ccctl/core";
import {
  asLaunchMarker,
  reconcileRecordedLaunches,
  rehydrateRetainedSessions,
  type LaunchMarker,
  type ProcessLivenessProbe,
  type RecordedLaunch,
  type ReconcileState,
} from "./session-reconcile.js";

// The orphan-reaper (#34) in ISOLATION — the across-restart reconciliation that partitions recorded
// launched-session handles into the survivors to rehydrate and the orphans to evict, decided solely by
// a READ-ONLY liveness probe. Hermetic: no server, no HTTP, no tmux, no real process — just the pure
// partition and the rehydrate seam, so each AC is pinned on its own. The wired-through, run-before-
// serving behavior is covered by `index.test.ts`.

/**
 * A fake recorded launch: a `connecting` session on a fixed clock, tagged with a launch-marker. The
 * marker is deliberately DISTINCT from the session id (`@…` vs `sess-…`) so a test can prove the probe
 * is keyed on the MARKER, never the id (AC5).
 */
function recorded(id: string, marker: string): RecordedLaunch {
  return { session: createSession(id, "default", 1_000), marker: asLaunchMarker(marker) };
}

/**
 * A recorded launch still in `registering` — a UC2 launch whose terminal came up but whose worker had not
 * registered when the daemon went down. Its surface is the one MOST likely to still be alive on the next
 * start (it was spawned seconds earlier), which is exactly what makes restoring it dangerous.
 */
function recordedRegistering(id: string, marker: string): RecordedLaunch {
  return { session: createRegisteringSession(id, "default", 1_000), marker: asLaunchMarker(marker) };
}

/**
 * A liveness probe backed by an explicit set of live markers, plus a record of every marker it was
 * asked about — so a test can assert WHICH key the reaper probed by, and that it is asked liveness and
 * nothing else (the port has no other verb — "never kills" is structural, this makes the read observable).
 */
function fakeProbe(liveMarkers: readonly string[]) {
  const live = new Set(liveMarkers);
  const asked: LaunchMarker[] = [];
  const probe: ProcessLivenessProbe = (marker) => {
    asked.push(marker);
    return live.has(marker);
  };
  return { probe, asked };
}

describe("reconcileRecordedLaunches", () => {
  // Rule: A recorded handle whose process is gone is evicted.
  it("evicts a recorded handle whose surface is gone — a dead handle is reaped (AC2)", () => {
    const dead = recorded("sess-dead", "@dead");
    const { probe } = fakeProbe([]); // nothing is live

    const { retained, evicted } = reconcileRecordedLaunches([dead], probe);

    expect(retained).toEqual([]);
    expect(evicted).toEqual([dead]);
  });

  // Rule: A recorded handle with a live process is retained.
  it("retains a recorded handle whose surface is still alive — a live handle is kept (AC3)", () => {
    const alive = recorded("sess-alive", "@alive");
    const { probe } = fakeProbe(["@alive"]);

    const { retained, evicted } = reconcileRecordedLaunches([alive], probe);

    expect(retained).toEqual([alive]);
    expect(evicted).toEqual([]);
  });

  // Rule: The reaper never kills a live process — a taken-over process is left running.
  it("leaves a taken-over live surface running: reconciles the record, signals no process (AC4)", () => {
    // The operator `tmux attach`ed and took this session over locally; its surface is very much alive.
    const takenOver = recorded("sess-takenover", "@takenover");
    const { probe, asked } = fakeProbe(["@takenover"]);

    const { retained, evicted } = reconcileRecordedLaunches([takenOver], probe);

    // The record is retained (not evicted), and the SAME session object is handed back untouched —
    // reconciliation is over records, not surfaces. There is no teardown handle on a RecordedLaunch and
    // no verb on the probe but liveness, so "never kills a live process" holds by construction; this
    // asserts the observable half — the only thing the reaper ever did to the marker was READ it.
    expect(retained).toEqual([takenOver]);
    expect(retained[0]?.session).toBe(takenOver.session);
    expect(evicted).toEqual([]);
    expect(asked).toEqual([asLaunchMarker("@takenover")]);
  });

  it("keys liveness on the launch-marker, never the session id or a raw PID (AC5)", () => {
    // Cross the wires: each record's marker is live/dead the OPPOSITE of whether its id is in the live
    // set. A reaper that (wrongly) probed by session id would retain `keyed-by-id` and evict `keyed-by-
    // marker` — the exact inverse of the correct verdict. Probing by marker gives the verdict below.
    const keyedByMarker = recorded("sess-A", "@A"); // id absent from live set, marker present → ALIVE
    const keyedById = recorded("sess-B", "@B"); //     id present in live set, marker absent  → DEAD
    const { probe, asked } = fakeProbe(["@A", "sess-B"]);

    const { retained, evicted } = reconcileRecordedLaunches([keyedByMarker, keyedById], probe);

    expect(retained).toEqual([keyedByMarker]);
    expect(evicted).toEqual([keyedById]);
    // Proof the correlation key handed to the probe is the MARKER, not the id (and not a PID).
    expect(asked).toEqual([asLaunchMarker("@A"), asLaunchMarker("@B")]);
  });

  it("partitions a mixed set totally and preserves recorded order within each side", () => {
    const a = recorded("sess-a", "@a"); // alive
    const b = recorded("sess-b", "@b"); // dead
    const c = recorded("sess-c", "@c"); // alive
    const d = recorded("sess-d", "@d"); // dead
    const { probe } = fakeProbe(["@a", "@c"]);

    const { retained, evicted } = reconcileRecordedLaunches([a, b, c, d], probe);

    // Total partition (every input on exactly one side) with launch order preserved within each.
    expect(retained).toEqual([a, c]);
    expect(evicted).toEqual([b, d]);
    expect(retained.length + evicted.length).toBe(4);
  });

  it("evicts a `registering` record even when its surface is ALIVE — core forbids restoring one (#33 ghost)", () => {
    // The nastiest case, and the likeliest: the daemon launched a terminal, the worker had not registered
    // yet, and the daemon restarted. The tmux window is still up, so a liveness-only reaper would RETAIN it
    // and re-seed a `registering` row — which `@ccctl/core` § SessionStatus forbids outright ("A `registering`
    // session must never be RESTORED"): nothing can claim it (rejectIfRegistering 409s every worker leg) and
    // nothing is left to evict it, so it would be an immortal ghost in GET /api/sessions — precisely what #33
    // exists to prevent. Its ROW must go even though its surface lives.
    const ghost = recordedRegistering("sess-ghost", "@ghost");
    const { probe, asked } = fakeProbe(["@ghost"]); // its surface is very much alive

    const { retained, evicted } = reconcileRecordedLaunches([ghost], probe);

    expect(retained).toEqual([]);
    expect(evicted).toEqual([ghost]);
    // Not even probed: liveness cannot change the answer for an unresolvable row.
    expect(asked).toEqual([]);
  });

  it("evicts a `registering` record without touching a live sibling's verdict", () => {
    // A registering ghost alongside an ordinary live session: the ghost's row goes, the live one is kept.
    const ghost = recordedRegistering("sess-ghost", "@ghost");
    const live = recorded("sess-live", "@live");
    const { probe } = fakeProbe(["@ghost", "@live"]);

    const { retained, evicted } = reconcileRecordedLaunches([ghost, live], probe);

    expect(retained).toEqual([live]);
    expect(evicted).toEqual([ghost]);
  });

  it("is a no-op on an empty record set — a fresh daemon with nothing recorded", () => {
    const { probe, asked } = fakeProbe(["@anything"]);

    const { retained, evicted } = reconcileRecordedLaunches([], probe);

    expect(retained).toEqual([]);
    expect(evicted).toEqual([]);
    expect(asked).toEqual([]); // nothing to probe
  });
});

describe("rehydrateRetainedSessions", () => {
  function makeState(): ReconcileState {
    return { sessions: new Map<string, Session>() };
  }

  it("re-seeds each retained session into the registry by id — the survivors reappear (AC3 rehydrate)", () => {
    const state = makeState();
    const one = recorded("sess-1", "@1");
    const two = recorded("sess-2", "@2");

    rehydrateRetainedSessions(state, [one, two]);

    expect([...state.sessions.keys()]).toEqual(["sess-1", "sess-2"]);
    expect(state.sessions.get("sess-1")).toBe(one.session);
    expect(state.sessions.get("sess-2")).toBe(two.session);
  });

  it("is idempotent — a second rehydrate over the same survivors changes nothing", () => {
    const state = makeState();
    const survivor = recorded("sess-x", "@x");

    rehydrateRetainedSessions(state, [survivor]);
    rehydrateRetainedSessions(state, [survivor]);

    expect(state.sessions.size).toBe(1);
    expect(state.sessions.get("sess-x")).toBe(survivor.session);
  });

  it("seeds nothing for an empty retained set", () => {
    const state = makeState();

    rehydrateRetainedSessions(state, []);

    expect(state.sessions.size).toBe(0);
  });

  it("refuses to seed a `registering` session even when handed one as retained (boundary guard)", () => {
    // Deliberate double enforcement: reconcileRecordedLaunches already classifies a `registering` record as
    // evicted, so this is unreachable through the normal path. It is guarded anyway for the reason
    // persistableSnapshot filters on BOTH save and load — this is the boundary that WRITES the registry, and
    // a caller assembling `retained` by another route must not be able to poison the session list with a row
    // core forbids restoring.
    const state = makeState();
    const ghost = recordedRegistering("sess-ghost", "@ghost");
    const live = recorded("sess-live", "@live");

    rehydrateRetainedSessions(state, [ghost, live]);

    expect(state.sessions.has("sess-ghost")).toBe(false);
    expect([...state.sessions.keys()]).toEqual(["sess-live"]);
  });
});
