// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  NEEDS_YOU_RECONCILE_PATH,
  NEEDS_YOU_ACK_PATH,
  REQUIRES_ACTION_KIND,
  DEFAULT_NEEDS_YOU_DETAIL,
  decodeUnreadEntry,
  reconcileNeedsYou,
  needsYouAckBody,
  needsYouKey,
  needsYouDetail,
} from "./needs-you.js";

/** A well-formed `UnreadEntry` fixture — the wire shape the server's reconcile returns per entry. */
function entry({
  sessionId = "11111111-2222-3333-4444-555555555555",
  eventId = 1,
  at = 1_700_000_000_000,
  detail = "Approve the edit?",
} = {}) {
  return { sessionId, eventId, at, activity: { kind: REQUIRES_ACTION_KIND, detail } };
}

describe("mirrored routes + constants", () => {
  it("NEEDS_YOU_RECONCILE_PATH is the hub-global reconcile route (mirror-ahead of #47)", () => {
    expect(NEEDS_YOU_RECONCILE_PATH).toBe("/api/needs-you");
  });

  it("NEEDS_YOU_ACK_PATH is the ack route (mirror-ahead of #47)", () => {
    expect(NEEDS_YOU_ACK_PATH).toBe("/api/needs-you/ack");
  });

  it("REQUIRES_ACTION_KIND mirrors @ccctl/core's blocking activity kind", () => {
    expect(REQUIRES_ACTION_KIND).toBe("requires_action");
  });

  it("DEFAULT_NEEDS_YOU_DETAIL mirrors @ccctl/core's requires_action fallback line", () => {
    expect(DEFAULT_NEEDS_YOU_DETAIL).toBe("Awaiting input.");
  });
});

describe("decodeUnreadEntry", () => {
  it("accepts a well-formed entry and returns a fresh normalized copy", () => {
    const wire = entry();
    const decoded = decodeUnreadEntry(wire);
    expect(decoded).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555",
      eventId: 1,
      at: 1_700_000_000_000,
      activity: { kind: "requires_action", detail: "Approve the edit?" },
    });
    // Fresh object — never an alias of the wire value (nor its nested activity).
    expect(decoded).not.toBe(wire);
    expect(decoded.activity).not.toBe(wire.activity);
  });

  it("preserves an empty-string detail (needsYouDetail owns the blank fallback, not the decoder)", () => {
    expect(decodeUnreadEntry(entry({ detail: "" }))?.activity.detail).toBe("");
  });

  it("rejects a non-object / null / array", () => {
    expect(decodeUnreadEntry(null)).toBeNull();
    expect(decodeUnreadEntry(undefined)).toBeNull();
    expect(decodeUnreadEntry("x")).toBeNull();
    expect(decodeUnreadEntry(42)).toBeNull();
    expect(decodeUnreadEntry([entry()])).toBeNull();
  });

  it("rejects a missing / blank / non-string sessionId", () => {
    expect(decodeUnreadEntry(entry({ sessionId: "" }))).toBeNull();
    expect(decodeUnreadEntry(entry({ sessionId: "   " }))).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), sessionId: 7 })).toBeNull();
    const { sessionId: _drop, ...noSession } = entry();
    expect(decodeUnreadEntry(noSession)).toBeNull();
  });

  it("rejects an eventId that is not an integer >= 1 (the server's cursor starts at 1)", () => {
    expect(decodeUnreadEntry(entry({ eventId: 0 }))).toBeNull();
    expect(decodeUnreadEntry(entry({ eventId: -3 }))).toBeNull();
    expect(decodeUnreadEntry(entry({ eventId: 1.5 }))).toBeNull();
    expect(decodeUnreadEntry(entry({ eventId: "1" }))).toBeNull();
    expect(decodeUnreadEntry(entry({ eventId: Number.NaN }))).toBeNull();
    // The boundary value 1 is accepted.
    expect(decodeUnreadEntry(entry({ eventId: 1 }))?.eventId).toBe(1);
  });

  it("rejects a non-finite at", () => {
    expect(decodeUnreadEntry(entry({ at: Number.NaN }))).toBeNull();
    expect(decodeUnreadEntry(entry({ at: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), at: "soon" })).toBeNull();
  });

  it("rejects an activity that is not a requires_action with a string detail", () => {
    expect(decodeUnreadEntry({ ...entry(), activity: null })).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), activity: { kind: "idle" } })).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), activity: { kind: "running" } })).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), activity: { kind: "requires_action" } })).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), activity: { kind: "requires_action", detail: 9 } })).toBeNull();
    expect(decodeUnreadEntry({ ...entry(), activity: [REQUIRES_ACTION_KIND] })).toBeNull();
  });
});

describe("reconcileNeedsYou", () => {
  it("returns exactly the server's un-acked set (membership is the server's, not a client cursor)", () => {
    const a = entry({ sessionId: "aaa", eventId: 3 });
    const b = entry({ sessionId: "aaa", eventId: 7 });
    const decoded = reconcileNeedsYou({ unread: [a, b] });
    expect(decoded.map((e) => e.eventId)).toEqual([3, 7]);
  });

  it("orders a session's entries by eventId ascending (AC2 'ordered by Last-Event-ID')", () => {
    const scrambled = { unread: [entry({ eventId: 40 }), entry({ eventId: 2 }), entry({ eventId: 9 })] };
    expect(reconcileNeedsYou(scrambled).map((e) => e.eventId)).toEqual([2, 9, 40]);
  });

  it("re-surfaces an old-eventId entry — no delivery cutoff by the live cursor (the backstop guarantee)", () => {
    // A needs-you at eventId=5 whose push was lost, on a session whose live SSE cursor advanced far
    // past it, MUST still be delivered — reconcile applies NO client cursor. (unread-queue.ts AC3.)
    const decoded = reconcileNeedsYou({ unread: [entry({ eventId: 5 })] });
    expect(decoded).toHaveLength(1);
    expect(decoded[0].eventId).toBe(5);
  });

  it("groups sessions deterministically by sessionId, ordering each session's entries by eventId", () => {
    const decoded = reconcileNeedsYou({
      unread: [
        entry({ sessionId: "bbb", eventId: 2 }),
        entry({ sessionId: "aaa", eventId: 5 }),
        entry({ sessionId: "aaa", eventId: 1 }),
        entry({ sessionId: "bbb", eventId: 1 }),
      ],
    });
    expect(decoded.map((e) => `${e.sessionId}:${e.eventId}`)).toEqual(["aaa:1", "aaa:5", "bbb:1", "bbb:2"]);
  });

  it("drops malformed elements but keeps the well-formed ones (one bad entry never blanks the queue)", () => {
    const decoded = reconcileNeedsYou({
      unread: [entry({ sessionId: "aaa", eventId: 1 }), { sessionId: "", eventId: 2 }, null, "junk"],
    });
    expect(decoded).toHaveLength(1);
    expect(decoded[0].sessionId).toBe("aaa");
  });

  it("reads a shapeless / absent / route-not-wired body as an empty queue, never a throw", () => {
    // The mirror-ahead route 404s until the server wires it; a tunnel can interpose an error page.
    expect(reconcileNeedsYou(null)).toEqual([]);
    expect(reconcileNeedsYou(undefined)).toEqual([]);
    expect(reconcileNeedsYou({})).toEqual([]);
    expect(reconcileNeedsYou({ unread: "not-an-array" })).toEqual([]);
    expect(reconcileNeedsYou("<html>404</html>")).toEqual([]);
  });
});

describe("needsYouAckBody", () => {
  it("returns the (sessionId, eventId) ack key the server's ackUnread removes by", () => {
    expect(needsYouAckBody(entry({ sessionId: "sess-9", eventId: 4 }))).toEqual({ sessionId: "sess-9", eventId: 4 });
  });

  it("returns a fresh object, not an alias of the entry", () => {
    const e = entry();
    const body = needsYouAckBody(e);
    expect(body).not.toBe(e);
  });

  it("returns null for an entry lacking a usable key (never POST a keyless ack)", () => {
    expect(needsYouAckBody(null)).toBeNull();
    expect(needsYouAckBody({ sessionId: "", eventId: 1 })).toBeNull();
    expect(needsYouAckBody({ sessionId: "x", eventId: 0 })).toBeNull();
    expect(needsYouAckBody({ sessionId: "x", eventId: 1.5 })).toBeNull();
  });
});

describe("needsYouKey", () => {
  it("is a stable `${sessionId}:${eventId}` string", () => {
    expect(needsYouKey(entry({ sessionId: "sess-9", eventId: 4 }))).toBe("sess-9:4");
  });

  it("agrees with needsYouAckBody on what a usable entry is (both null together)", () => {
    const bad = { sessionId: "x", eventId: 0 };
    expect(needsYouKey(bad)).toBeNull();
    expect(needsYouAckBody(bad)).toBeNull();
  });
});

describe("needsYouDetail", () => {
  it("surfaces the entry's activity.detail when present", () => {
    expect(needsYouDetail(entry({ detail: "Approve tool use?" }))).toBe("Approve tool use?");
  });

  it("falls back to DEFAULT_NEEDS_YOU_DETAIL for a blank / absent / non-string detail", () => {
    expect(needsYouDetail(entry({ detail: "" }))).toBe(DEFAULT_NEEDS_YOU_DETAIL);
    expect(needsYouDetail(entry({ detail: "   " }))).toBe(DEFAULT_NEEDS_YOU_DETAIL);
    expect(needsYouDetail({ activity: { detail: 9 } })).toBe(DEFAULT_NEEDS_YOU_DETAIL);
    expect(needsYouDetail({ activity: { kind: "requires_action" } })).toBe(DEFAULT_NEEDS_YOU_DETAIL);
    expect(needsYouDetail(null)).toBe(DEFAULT_NEEDS_YOU_DETAIL);
    expect(needsYouDetail({})).toBe(DEFAULT_NEEDS_YOU_DETAIL);
  });
});
