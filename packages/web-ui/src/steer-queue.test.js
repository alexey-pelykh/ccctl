// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  QUEUED_PENDING,
  QUEUED_STALE,
  OFFLINE,
  shouldQueueSteer,
  queuedSteer,
  cancelQueued,
  partitionQueueForFire,
} from "./steer-queue.js";

/** A representative steer body as `command.js` builds it, for queue-shape tests. */
const inputSteer = { subtype: "prompt", payload: { text: "continue" } };

describe("status + verdict constants", () => {
  it("pins the queued-item statuses and the offline verdict it gates on", () => {
    expect(QUEUED_PENDING).toBe("pending");
    expect(QUEUED_STALE).toBe("stale");
    // Mirrors connection.js OFFLINE — the seam between the two modules.
    expect(OFFLINE).toBe("offline");
  });
});

describe("shouldQueueSteer", () => {
  it("queues a steer only when the link is offline (a down heartbeat can't POST) — AC1", () => {
    expect(shouldQueueSteer("offline")).toBe(true);
  });

  it("sends (does not queue) while live or reconnecting — the request path may still carry it", () => {
    expect(shouldQueueSteer("live")).toBe(false);
    expect(shouldQueueSteer("reconnecting")).toBe(false);
  });

  it("defends against an unknown or absent verdict by not queuing (never a false offline)", () => {
    expect(shouldQueueSteer("")).toBe(false);
    expect(shouldQueueSteer(undefined)).toBe(false);
    expect(shouldQueueSteer(null)).toBe(false);
    expect(shouldQueueSteer("OFFLINE")).toBe(false);
  });
});

describe("queuedSteer", () => {
  it("builds a pending item carrying the id, target session, and command verbatim — AC1", () => {
    expect(queuedSteer({ id: 1, sessionId: "sess-a", command: inputSteer })).toEqual({
      id: 1,
      sessionId: "sess-a",
      command: inputSteer,
      status: QUEUED_PENDING,
    });
  });

  it("carries the command by reference — it is the immutable value command.js just built", () => {
    const item = queuedSteer({ id: 2, sessionId: "sess-a", command: inputSteer });
    expect(item?.command).toBe(inputSteer);
  });

  it("returns null for a non-integer id, so the shell never queues a cancel-keyless item", () => {
    expect(queuedSteer({ id: undefined, sessionId: "sess-a", command: inputSteer })).toBeNull();
    expect(queuedSteer({ id: 1.5, sessionId: "sess-a", command: inputSteer })).toBeNull();
    expect(queuedSteer({ id: "1", sessionId: "sess-a", command: inputSteer })).toBeNull();
  });

  it("returns null for a blank or non-string sessionId — a steer with no target", () => {
    expect(queuedSteer({ id: 1, sessionId: "", command: inputSteer })).toBeNull();
    expect(queuedSteer({ id: 1, sessionId: "   ", command: inputSteer })).toBeNull();
    expect(queuedSteer({ id: 1, sessionId: null, command: inputSteer })).toBeNull();
  });

  it("returns null for a value that is not a steer command", () => {
    expect(queuedSteer({ id: 1, sessionId: "sess-a", command: null })).toBeNull();
    expect(queuedSteer({ id: 1, sessionId: "sess-a", command: { payload: {} } })).toBeNull();
    expect(queuedSteer({ id: 1, sessionId: "sess-a", command: [] })).toBeNull();
    expect(queuedSteer(undefined)).toBeNull();
  });
});

describe("cancelQueued", () => {
  const queue = [
    { id: 1, sessionId: "a", command: inputSteer, status: QUEUED_PENDING },
    { id: 2, sessionId: "a", command: inputSteer, status: QUEUED_PENDING },
    { id: 3, sessionId: "a", command: inputSteer, status: QUEUED_PENDING },
  ];

  it("removes the item with the given id and keeps the rest in order — AC3", () => {
    expect(cancelQueued(queue, 2).map((item) => item.id)).toEqual([1, 3]);
  });

  it("never mutates the input queue (the shell re-renders from the returned array)", () => {
    const before = queue.map((item) => item.id);
    cancelQueued(queue, 2);
    expect(queue.map((item) => item.id)).toEqual(before);
  });

  it("is an idempotent no-op for an id not present (a Cancel that raced the item firing)", () => {
    expect(cancelQueued(queue, 99).map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("empties a single-item queue", () => {
    expect(cancelQueued([queue[0]], 1)).toEqual([]);
  });
});

describe("partitionQueueForFire", () => {
  const queue = [
    { id: 1, sessionId: "a", command: inputSteer, status: QUEUED_PENDING },
    { id: 2, sessionId: "b", command: inputSteer, status: QUEUED_PENDING },
    { id: 3, sessionId: "a", command: inputSteer, status: QUEUED_PENDING },
  ];

  it("with the default (unarmed) guard fires every item in order and holds none — the #79 goal, AC2", () => {
    const { send, hold } = partitionQueueForFire(queue);
    // FIFO order preserved — the shell POSTs these sequentially so they land in order.
    expect(send.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(hold).toEqual([]);
  });

  it("routes every item through the stale-guard exactly once at fire time — AC4 seam", () => {
    const seen = [];
    partitionQueueForFire(queue, (item) => {
      seen.push(item.id);
      return false;
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("holds the items the guard marks stale and sends the rest, both in order — AC4", () => {
    // A guard that says session "b" moved on: item 2 is held, 1 and 3 still fire.
    const { send, hold } = partitionQueueForFire(queue, (item) => item.sessionId === "b");
    expect(send.map((item) => item.id)).toEqual([1, 3]);
    expect(hold.map((item) => item.id)).toEqual([2]);
  });

  it("re-stamps a held item as stale without mutating the input item", () => {
    const { hold } = partitionQueueForFire(queue, (item) => item.id === 2);
    expect(hold[0].status).toBe(QUEUED_STALE);
    // The source item is untouched — a fresh object was pushed to hold.
    expect(queue[1].status).toBe(QUEUED_PENDING);
  });

  it("sends nothing and holds everything when the guard holds all (order preserved) — the #80-armed extreme", () => {
    const { send, hold } = partitionQueueForFire(queue, () => true);
    expect(send).toEqual([]);
    expect(hold.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(hold.every((item) => item.status === QUEUED_STALE)).toBe(true);
  });

  it("handles an empty queue", () => {
    expect(partitionQueueForFire([])).toEqual({ send: [], hold: [] });
  });
});
