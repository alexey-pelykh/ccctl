// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { UnreadEntry } from "@ccctl/core";
import { ackUnread } from "./unread-queue.js";
import { isPushSuppressed, recordLiveAck, type EventKey } from "./push-suppression.js";

// A fixed epoch so every fixture is deterministic (mirrors the sibling store/queue/cadence tests).
const T0 = 1_000_000;

const S1 = "sess-one";
const S2 = "sess-two";

/**
 * A blocking needs-you unread entry (#47): the persisted FACE of a `requires_action` notification. It
 * carries the `(sessionId, eventId)` ack key, so — by structural typing — it doubles as an {@link EventKey},
 * exactly as the #50 dispatcher would pass a re-nudge's entry ({@link https://ccctl | DueRenudge.entry})
 * straight into a suppression check.
 */
function blockingEvent(sessionId: string, eventId: number, firedAt = T0): UnreadEntry {
  return { sessionId, eventId, at: firedAt, activity: { kind: "requires_action", detail: "Approve tool use?" } };
}

describe("push-suppression — AC1: a live client's ack suppresses the redundant push for that same event", () => {
  it("suppresses the push once the event's live ack is recorded", () => {
    const acknowledged = recordLiveAck([], S1, 5);
    // The operator handled the block on the connected client, so its rung-2 push is pure redundancy.
    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 5 })).toBe(true);
  });

  it("accepts a full UnreadEntry as the wake target (structural key) — a re-nudge entry needs no adapting", () => {
    const acknowledged = recordLiveAck([], S1, 5);
    // What #48's dueRenudges hands the dispatcher is an UnreadEntry; it IS an EventKey.
    expect(isPushSuppressed(acknowledged, blockingEvent(S1, 5))).toBe(true);
  });
});

describe("push-suppression — AC2: with no live ack the push proceeds (suppression never swallows a genuine wake)", () => {
  it("does NOT suppress when nothing has been acknowledged", () => {
    expect(isPushSuppressed([], { sessionId: S1, eventId: 5 })).toBe(false);
  });

  it("does NOT suppress a genuine block merely because OTHER events were acked", () => {
    const acknowledged = recordLiveAck(recordLiveAck([], S1, 4), S1, 6);
    // Event 5 was never acknowledged — its push must proceed even though its neighbours were handled.
    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 5 })).toBe(false);
  });
});

describe("push-suppression — AC3: suppression is scoped per-event (acking A does not suppress B)", () => {
  it("acking event A does not suppress a different event B in the same session", () => {
    const acknowledged = recordLiveAck([], S1, 5); // A = (S1, 5)
    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 5 })).toBe(true); // A itself is suppressed
    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 6 })).toBe(false); // B = (S1, 6) proceeds
  });

  it("matches on sessionId TOO — two sessions sharing an eventId integer never cross-suppress", () => {
    // `eventId` is a per-session cursor, so (S1, 5) and (S2, 5) are DIFFERENT events. A key that matched on
    // eventId alone would wrongly suppress S2's push; this is the discriminating check that it does not.
    const acknowledged = recordLiveAck([], S1, 5);
    expect(isPushSuppressed(acknowledged, { sessionId: S2, eventId: 5 })).toBe(false);
    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 5 })).toBe(true);
  });
});

describe("push-suppression — AC4: the ack-vs-dispatch race tiebreaks toward SENDING", () => {
  it("proceeds when the ack is not yet recorded at dispatch-check time, then suppresses once it is", () => {
    const wake: EventKey = { sessionId: S1, eventId: 5 };
    // Dispatch-check wins the race: the ack has not landed yet → the push proceeds (a redundant push beats
    // a missed one). The still-pending ack simply suppresses the NEXT wake (a re-nudge, #48) instead.
    expect(isPushSuppressed([], wake)).toBe(false);
    // Ack wins the race: recorded before the check → the redundant push is suppressed.
    expect(isPushSuppressed(recordLiveAck([], S1, 5), wake)).toBe(true);
  });

  it("never suppresses a needed wake on ABSENCE — the enqueue-vs-dispatch race is safe too", () => {
    // Suppression keys off a POSITIVE ack, never off unread-queue absence: a genuine, still-unhandled block
    // that merely raced its own enqueue is absent from the acked set and so is NEVER dropped. (Keying off
    // queue-absence would conflate "acknowledged" with "not yet enqueued" and swallow this needed wake.)
    const unhandled = blockingEvent(S1, 5);
    expect(isPushSuppressed([], unhandled)).toBe(false);
    // Even with a populated acked set for unrelated events, the un-acked block still sends.
    expect(isPushSuppressed(recordLiveAck([], S2, 5), unhandled)).toBe(false);
  });
});

describe("push-suppression — composes with #47 ack-by-removal (one operator action, one ack key)", () => {
  it("a live ack both suppresses the push (this module) and removes the queue entry (#47), keyed identically", () => {
    // The wiring turns ONE operator ack into both effects on the SAME (sessionId, eventId): record it here
    // to suppress the redundant push, and ackUnread it (#47) to drop it from the permanent unread queue.
    const queue: readonly UnreadEntry[] = [blockingEvent(S1, 5), blockingEvent(S2, 6)];
    const acknowledged = recordLiveAck([], S1, 5);
    const queueAfterAck = ackUnread(queue, S1, 5);

    expect(isPushSuppressed(acknowledged, { sessionId: S1, eventId: 5 })).toBe(true); // push suppressed
    expect(queueAfterAck).toEqual([blockingEvent(S2, 6)]); // and only (S1,5) left the queue — S2 untouched
  });
});

describe("push-suppression — recordLiveAck is idempotent per event identity", () => {
  it("recording the same live ack twice does not double-grow the set (two clients acking one block)", () => {
    const once = recordLiveAck([], S1, 5);
    const twice = recordLiveAck(once, S1, 5);
    expect(twice).toBe(once); // unchanged reference — a duplicate carries no new information
    expect(twice).toHaveLength(1);
    expect(isPushSuppressed(twice, { sessionId: S1, eventId: 5 })).toBe(true);
  });

  it("distinct events accumulate — idempotence is per (sessionId, eventId), not global", () => {
    const acknowledged = recordLiveAck(recordLiveAck(recordLiveAck([], S1, 5), S1, 6), S2, 5);
    expect(acknowledged).toHaveLength(3);
  });
});

describe("push-suppression — pure, frozen, and non-mutating (the #45/#46/#47/#48 stance)", () => {
  it("recordLiveAck returns a NEW array and never mutates its input (which may be frozen)", () => {
    const acknowledged = Object.freeze<readonly EventKey[]>([{ sessionId: S1, eventId: 5 }]);
    const next = recordLiveAck(acknowledged, S1, 6);
    expect(next).not.toBe(acknowledged);
    expect(next).toHaveLength(2);
    expect(acknowledged).toHaveLength(1); // input unchanged
  });

  it("records FROZEN keys — a consumer cannot mutate a recorded ack's session/event out from under a check", () => {
    const [recorded] = recordLiveAck([], S1, 5);
    expect(Object.isFrozen(recorded)).toBe(true);
  });

  it("isPushSuppressed is a pure function of its inputs — same inputs, same decision, no mutation", () => {
    const acknowledged = recordLiveAck([], S1, 5);
    const wake: EventKey = { sessionId: S1, eventId: 5 };
    expect(isPushSuppressed(acknowledged, wake)).toBe(isPushSuppressed(acknowledged, wake));
    expect(acknowledged).toHaveLength(1); // unchanged
  });
});
