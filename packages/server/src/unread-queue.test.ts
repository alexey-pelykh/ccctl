// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  SESSION_STORE_SNAPSHOT_VERSION,
  type Session,
  type SessionStoreSnapshot,
  type UnreadEntry,
} from "@ccctl/core";
import { createFileSessionStore } from "./session-store-file.js";
import { ackUnread, enqueueUnread, reconcileUnread } from "./unread-queue.js";

// A fixed epoch so every fixture is deterministic (mirrors the sibling store tests).
const T0 = 1_000_000;

const S1 = "sess-one";
const S2 = "sess-two";

/**
 * A blocking needs-you unread entry: the persisted FACE of a `requires_action`
 * notification. `eventId` is the per-session SSE `Last-Event-ID` the event was
 * broadcast under — the queue's order key (AC2) and ack key (AC4).
 */
function needsYou(sessionId: string, eventId: number, detail = "Approve tool use?"): UnreadEntry {
  return { sessionId, eventId, at: T0 + eventId, activity: { kind: "requires_action", detail } };
}

describe("unread-queue — AC1: a blocking needs-you is enqueued to the (persisted) unread queue", () => {
  it("enqueues the event — it is present in the queue afterwards", () => {
    const entry = needsYou(S1, 5);
    expect(enqueueUnread([], entry)).toEqual([entry]);
  });

  it("appends to a non-empty queue, preserving the existing entries", () => {
    const first = needsYou(S1, 5);
    const second = needsYou(S1, 6);
    expect(enqueueUnread([first], second)).toEqual([first, second]);
  });

  it("is pure — it returns a new array and never mutates the input (input may be frozen)", () => {
    const queue = Object.freeze([needsYou(S1, 5)]);
    const next = enqueueUnread(queue, needsYou(S1, 6));
    expect(next).not.toBe(queue);
    expect(queue).toEqual([needsYou(S1, 5)]); // unchanged
  });

  it("dedupes a re-enqueued (sessionId, eventId) — one event badges once, never twice", () => {
    // The enqueue seam is idempotent per event identity, so a retried emission of the
    // SAME broadcast cannot double-badge one blocking event.
    const entry = needsYou(S1, 5);
    const once = enqueueUnread([], entry);
    expect(enqueueUnread(once, entry)).toEqual([entry]);
  });

  it("carries the entry through a JSON snapshot unchanged — it is PERSISTED, not in-memory only", () => {
    const entry = needsYou(S1, 5);
    const snapshot: SessionStoreSnapshot = {
      version: SESSION_STORE_SNAPSHOT_VERSION,
      sessions: [],
      unread: enqueueUnread([], entry),
    };
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as SessionStoreSnapshot;
    expect(roundTripped.unread).toEqual([entry]);
  });
});

describe("unread-queue — AC2: reconnect delivers EXACTLY the un-acked entries, ordered by Last-Event-ID", () => {
  it("returns a session's entries ordered by eventId ascending, whatever the enqueue order", () => {
    // Enqueued out of order; reconcile orders by the Last-Event-ID (eventId), not arrival.
    let queue: readonly UnreadEntry[] = [];
    for (const id of [9, 2, 5]) {
      queue = enqueueUnread(queue, needsYou(S1, id));
    }
    expect(reconcileUnread(queue, S1).map((entry) => entry.eventId)).toEqual([2, 5, 9]);
  });

  it("orders by eventId, NOT by `at` — a later-eventId entry with an EARLIER `at` still sorts last", () => {
    // Discriminating fixture: `at` order is the REVERSE of `eventId` order. A sort-by-`at`
    // regression (`left.at - right.at`) would yield [9, 5, 2] and fail here — pinning that the
    // order key is the Last-Event-ID (`eventId`, the whole reason the field was added), not the
    // wall-clock `at` (which can tie within a millisecond and resets per process across a restart).
    const entries: readonly UnreadEntry[] = [
      { sessionId: S1, eventId: 2, at: T0 + 900, activity: { kind: "requires_action", detail: "a" } },
      { sessionId: S1, eventId: 5, at: T0 + 500, activity: { kind: "requires_action", detail: "b" } },
      { sessionId: S1, eventId: 9, at: T0 + 100, activity: { kind: "requires_action", detail: "c" } },
    ];
    let queue: readonly UnreadEntry[] = [];
    for (const entry of entries) {
      queue = enqueueUnread(queue, entry);
    }
    expect(reconcileUnread(queue, S1).map((entry) => entry.eventId)).toEqual([2, 5, 9]);
  });

  it("delivers ONLY the still-un-acked entries — an entry acked from another client is excluded", () => {
    // Gherkin: the queue holds several un-acked entries; one was already acknowledged from
    // another client; on reconnect only the still-un-acked entries are delivered.
    let queue: readonly UnreadEntry[] = [];
    for (const id of [5, 6, 7]) {
      queue = enqueueUnread(queue, needsYou(S1, id));
    }
    queue = ackUnread(queue, S1, 6); // acknowledged elsewhere
    expect(reconcileUnread(queue, S1).map((entry) => entry.eventId)).toEqual([5, 7]);
  });

  it("is per-session — reconciling S1 never returns S2's entries (the SSE relay is per-session, #20)", () => {
    let queue: readonly UnreadEntry[] = [];
    queue = enqueueUnread(queue, needsYou(S1, 5));
    queue = enqueueUnread(queue, needsYou(S2, 6));
    expect(reconcileUnread(queue, S1)).toEqual([needsYou(S1, 5)]);
    expect(reconcileUnread(queue, S2)).toEqual([needsYou(S2, 6)]);
  });

  it("returns nothing for a session with no unread entries", () => {
    expect(reconcileUnread([needsYou(S2, 5)], S1)).toEqual([]);
  });
});

describe("unread-queue — AC3: the QUEUE is the source of truth, not the at-most-once push", () => {
  it("re-delivers an un-acked needs-you even though the client's SSE cursor advanced PAST it", () => {
    // The load-bearing test. A needs-you at eventId=5 whose push was lost/coalesced/expired, on
    // a session whose live SSE Last-Event-ID later advanced to 40. Reconcile takes NO client
    // cursor — delivery is decided by ACK STATE (still present) alone, never by an
    // `eventId > lastEventId` cutoff. A cursor-filtered reconcile would drop id=5 (5 < 40) and
    // silently lose the one blocking event the queue exists to guarantee.
    const lost = needsYou(S1, 5);
    const queue = enqueueUnread([], lost);
    // Later, unrelated live traffic pushed the SSE cursor to 40; the lost event was never acked.
    expect(reconcileUnread(queue, S1)).toEqual([lost]); // still delivered
    // reconcileUnread's signature carries no Last-Event-ID parameter — the cutoff is structurally
    // impossible to introduce by accident.
    expect(reconcileUnread.length).toBe(2); // (unread, sessionId) — no cursor arg
  });
});

describe("unread-queue — AC4: an acked event is not re-delivered; the queue survives a daemon restart", () => {
  it("ack-by-removal — an acked entry is gone from the queue and not re-delivered", () => {
    let queue: readonly UnreadEntry[] = enqueueUnread([], needsYou(S1, 5));
    queue = ackUnread(queue, S1, 5);
    expect(queue).toEqual([]);
    expect(reconcileUnread(queue, S1)).toEqual([]);
  });

  it("ack is idempotent and keyed on (sessionId, eventId) — acking an absent/other id is a no-op", () => {
    const queue: readonly UnreadEntry[] = enqueueUnread([], needsYou(S1, 5));
    expect(ackUnread(queue, S1, 999)).toEqual(queue); // no such eventId
    expect(ackUnread(queue, S2, 5)).toEqual(queue); // right eventId, wrong session
    const acked = ackUnread(queue, S1, 5);
    expect(ackUnread(acked, S1, 5)).toEqual([]); // acking twice is safe
  });

  it("is pure — ack returns a new array and never mutates the input (input may be frozen)", () => {
    const queue = Object.freeze([needsYou(S1, 5), needsYou(S1, 6)]);
    const next = ackUnread(queue, S1, 5);
    expect(next).not.toBe(queue);
    expect(queue.map((entry) => entry.eventId)).toEqual([5, 6]); // unchanged
  });

  it("survives a real daemon restart — un-acked entries persist, acked stay gone (file store round-trip)", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "ccctl-unread-")), "session-store.json");
    try {
      const served: Session = { ...createSession(S1, "default", T0), status: "ready" };

      // Enqueue two blocking events, ack one, then SAVE the snapshot (the daemon shutting down).
      let unread: readonly UnreadEntry[] = [];
      unread = enqueueUnread(unread, needsYou(S1, 5));
      unread = enqueueUnread(unread, needsYou(S1, 6));
      unread = ackUnread(unread, S1, 5); // one acknowledged before the restart
      await createFileSessionStore(filePath).save({
        version: SESSION_STORE_SNAPSHOT_VERSION,
        sessions: [served],
        unread,
      });

      // A fresh daemon LOADS the snapshot and the client reconnects.
      const restored = await createFileSessionStore(filePath).load();
      expect(restored).not.toBeNull();
      const reconciled = reconcileUnread(restored?.unread ?? [], S1);

      // The un-acked entry (6) is still delivered across the restart; the acked one (5) stays gone.
      expect(reconciled.map((entry) => entry.eventId)).toEqual([6]);
    } finally {
      await rm(filePath, { force: true }).catch(() => undefined);
      await rm(join(filePath, ".."), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
