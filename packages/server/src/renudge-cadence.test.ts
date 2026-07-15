// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { UnreadEntry } from "@ccctl/core";
import { ackUnread, reconcileUnread } from "./unread-queue.js";
import {
  DEFAULT_RENUDGE_BACKOFF_MS,
  dueRenudges,
  renudgeDecision,
  type RenudgeCadence,
  type RenudgeCandidate,
} from "./renudge-cadence.js";

// A fixed epoch so every fixture is deterministic (mirrors the sibling store/queue tests).
const T0 = 1_000_000;

const S1 = "sess-one";
const S2 = "sess-two";

// The default cadence is [30s, 2m, 5m, 15m]; the cumulative deadlines from a fire at T0 are:
//   re-nudge #0 at T0 + 30_000, #1 at T0 + 150_000, #2 at T0 + 450_000, #3 at T0 + 1_350_000, then exhausted.
const [D0, D1, D2, D3] = DEFAULT_RENUDGE_BACKOFF_MS;
const DEADLINE_0 = T0 + D0;
const DEADLINE_1 = T0 + D0 + D1;
const DEADLINE_2 = T0 + D0 + D1 + D2;
const DEADLINE_3 = T0 + D0 + D1 + D2 + D3;

/**
 * A blocking needs-you unread entry (#47): the persisted FACE of a `requires_action` notification. `at` is the
 * fire time — the initial wake — which the re-nudge cadence measures its escalating deadlines from.
 */
function blockingEvent(sessionId: string, eventId: number, firedAt = T0): UnreadEntry {
  return { sessionId, eventId, at: firedAt, activity: { kind: "requires_action", detail: "Approve tool use?" } };
}

/** A still-un-acked candidate the scheduler evaluates: a queued entry + how many re-nudges it has had. */
function candidate(entry: UnreadEntry, renudgesFired: number): RenudgeCandidate {
  return { entry, renudgesFired };
}

describe("renudge-cadence — AC1/AC2: an unacknowledged blocking event is re-nudged once its window elapses", () => {
  it("is `due` at the moment the first window elapses without an ack", () => {
    const decision = renudgeDecision(T0, 0, DEADLINE_0);
    expect(decision).toEqual({ kind: "due", renudgeIndex: 0, renudgeAt: DEADLINE_0 });
  });

  it("is still `pending` one millisecond BEFORE the window elapses — no premature re-nudge", () => {
    const decision = renudgeDecision(T0, 0, DEADLINE_0 - 1);
    expect(decision).toEqual({ kind: "pending", renudgeIndex: 0, renudgeAt: DEADLINE_0 });
  });

  it("`pending` carries the exact next deadline, so a caller sets a precise timer rather than polls", () => {
    const decision = renudgeDecision(T0, 0, T0);
    expect(decision.kind).toBe("pending");
    // The window is measured from the fire time, so the first re-nudge is exactly cadence[0] later.
    expect(decision.kind === "pending" && decision.renudgeAt).toBe(T0 + D0);
  });

  it("dueRenudges returns exactly the candidates whose window has elapsed, carrying the entry to re-wake", () => {
    const ready = blockingEvent(S1, 5); // fired at T0 → first window elapses at DEADLINE_0
    const notYet = blockingEvent(S2, 6, T0 + 100_000); // fired later → its window has not elapsed at DEADLINE_0
    const due = dueRenudges([candidate(ready, 0), candidate(notYet, 0)], DEADLINE_0 - 1);
    // Just before DEADLINE_0 neither window has elapsed — nothing is due.
    expect(due).toEqual([]);
    const dueNow = dueRenudges([candidate(ready, 0), candidate(notYet, 0)], DEADLINE_0);
    // At DEADLINE_0 only the earlier-fired event is due; the later-fired one is still pending.
    expect(dueNow).toEqual([{ entry: ready, renudgeIndex: 0, renudgeAt: DEADLINE_0 }]);
  });
});

describe("renudge-cadence — AC3: acknowledgement stops nudging (ack == removal from the #47 unread queue)", () => {
  it("acking BEFORE the window elapses stops any re-nudge — the removed entry is not a candidate", () => {
    // The operator acks while the event is still `pending` (window not yet elapsed).
    const queue: readonly UnreadEntry[] = [blockingEvent(S1, 5)];
    const acked = ackUnread(queue, S1, 5); // #47 ack-by-removal
    const candidates = reconcileUnread(acked, S1).map((entry) => candidate(entry, 0));
    // Even well past the first window, the acked event yields no re-nudge.
    expect(dueRenudges(candidates, DEADLINE_0 + 1)).toEqual([]);
  });

  it("acking AFTER several re-nudges stops nudging immediately — removal excludes it from the next tick", () => {
    // An event that has already been re-nudged twice and is due for a third at DEADLINE_2.
    const queue: readonly UnreadEntry[] = [blockingEvent(S1, 5)];
    expect(dueRenudges([candidate(queue[0], 2)], DEADLINE_2)).toHaveLength(1); // was about to fire re-nudge #2
    const acked = ackUnread(queue, S1, 5);
    const candidates = reconcileUnread(acked, S1).map((entry) => candidate(entry, 2));
    expect(dueRenudges(candidates, DEADLINE_2)).toEqual([]); // ack removed it → nudging stops at once
  });

  it("only the ACKED session stops — a sibling blocked session is still re-nudged", () => {
    const queue: readonly UnreadEntry[] = [blockingEvent(S1, 5), blockingEvent(S2, 6)];
    const acked = ackUnread(queue, S1, 5);
    const candidates = acked.map((entry) => candidate(entry, 0));
    const due = dueRenudges(candidates, DEADLINE_0);
    expect(due.map((renudge) => renudge.entry.sessionId)).toEqual([S2]);
  });
});

describe("renudge-cadence — AC4: re-nudging escalates per the cadence and does NOT run forever", () => {
  it("each successive re-nudge is due at its cumulative, ESCALATING deadline", () => {
    expect(renudgeDecision(T0, 0, DEADLINE_0)).toMatchObject({ kind: "due", renudgeIndex: 0 });
    expect(renudgeDecision(T0, 1, DEADLINE_1)).toMatchObject({ kind: "due", renudgeIndex: 1 });
    expect(renudgeDecision(T0, 2, DEADLINE_2)).toMatchObject({ kind: "due", renudgeIndex: 2 });
    expect(renudgeDecision(T0, 3, DEADLINE_3)).toMatchObject({ kind: "due", renudgeIndex: 3 });
  });

  it("the gaps between consecutive re-nudges GROW — it is a back-off, not a fixed tiny interval", () => {
    // Deadline_{k+1} - Deadline_k is cadence[k+1]; a discriminating check that each gap is strictly larger.
    const gaps = [DEADLINE_1 - DEADLINE_0, DEADLINE_2 - DEADLINE_1, DEADLINE_3 - DEADLINE_2];
    expect(gaps).toEqual([D1, D2, D3]);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    }
  });

  it("is `exhausted` once every cadence step has fired — re-nudging stops, it does not run forever", () => {
    // Four re-nudges (indices 0..3) then nothing, however far past the last deadline `now` runs.
    expect(renudgeDecision(T0, DEFAULT_RENUDGE_BACKOFF_MS.length, DEADLINE_3 + 10_000_000)).toEqual({
      kind: "exhausted",
    });
  });

  it("an exhausted event is NOT acknowledged — it stays in the #47 unread queue (the permanent backstop)", () => {
    // Exhaustion stops the pushes; the queue entry survives until a real ack/removal.
    const queue: readonly UnreadEntry[] = [blockingEvent(S1, 5)];
    expect(dueRenudges([candidate(queue[0], DEFAULT_RENUDGE_BACKOFF_MS.length)], DEADLINE_3 + 1)).toEqual([]);
    expect(reconcileUnread(queue, S1)).toEqual([blockingEvent(S1, 5)]); // still queued, still unread
  });

  it("an empty cadence is a valid 'never re-nudge' config — exhausted immediately", () => {
    const noRenudge: RenudgeCadence = [];
    expect(renudgeDecision(T0, 0, T0 + 10_000_000, noRenudge)).toEqual({ kind: "exhausted" });
    expect(dueRenudges([candidate(blockingEvent(S1, 5), 0)], T0 + 10_000_000, noRenudge)).toEqual([]);
  });

  it("honours an overridden cadence (the schedule is tunable, not settled)", () => {
    const tight: RenudgeCadence = [1_000, 2_000];
    expect(renudgeDecision(T0, 0, T0 + 1_000, tight)).toMatchObject({ kind: "due", renudgeIndex: 0 });
    expect(renudgeDecision(T0, 1, T0 + 3_000, tight)).toMatchObject({ kind: "due", renudgeIndex: 1 });
    expect(renudgeDecision(T0, 2, T0 + 3_000, tight)).toEqual({ kind: "exhausted" }); // only two steps
  });
});

describe("renudge-cadence — pure, deterministic, and restart-re-derivable (the #45/#46/#47 stance)", () => {
  it("is a pure function of (firedAt, renudgesFired, now) — no hidden state, same inputs same decision", () => {
    expect(renudgeDecision(T0, 1, DEADLINE_1)).toEqual(renudgeDecision(T0, 1, DEADLINE_1));
  });

  it("returns FROZEN decisions — a consumer cannot mutate a deadline back", () => {
    const decision = renudgeDecision(T0, 0, DEADLINE_0);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("re-derives the level after a restart from the reconciled entry's `at` alone — no separate timer state", () => {
    // A reconnect reconciles the queue (#47); the entry's `at` is all the cadence needs to place `now`.
    const restored = reconcileUnread([blockingEvent(S1, 5, T0)], S1);
    expect(restored).toHaveLength(1);
    // With renudgesFired re-derived/persisted as 2, at DEADLINE_2 the catch-up re-nudge #2 is due.
    expect(dueRenudges([candidate(restored[0], 2)], DEADLINE_2)).toEqual([
      { entry: restored[0], renudgeIndex: 2, renudgeAt: DEADLINE_2 },
    ]);
  });

  it("dueRenudges is pure — returns a new array and never mutates its input (which may be frozen)", () => {
    const candidates = Object.freeze([candidate(blockingEvent(S1, 5), 0)]);
    const due = dueRenudges(candidates, DEADLINE_0);
    expect(due).not.toBe(candidates);
    expect(candidates).toHaveLength(1); // unchanged
  });

  it("the default cadence is frozen — the shared tunable cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(DEFAULT_RENUDGE_BACKOFF_MS)).toBe(true);
  });
});
