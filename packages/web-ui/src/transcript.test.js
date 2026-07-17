// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  DEFAULT_REQUIRES_ACTION_DETAIL,
  SESSION_CLOSED_EVENT_TYPE,
  WORKER_STATUS_SUBTYPE,
  decodeControlEvent,
  decodeSessionClosed,
  closedText,
  isWorkerStatusEvent,
  activityText,
  activityFromEvent,
  summarizePayload,
  formatTranscriptEntry,
  processEventData,
} from "./transcript.js";

/** Serialize a value the way the server's SSE `data:` line carries it. */
const line = (value) => JSON.stringify(value);

describe("decodeControlEvent", () => {
  it("decodes a well-formed control event", () => {
    const result = decodeControlEvent(line({ type: "control_event", subtype: "message", payload: { text: "hi" } }));
    expect(result).toEqual({
      ok: true,
      event: { type: "control_event", subtype: "message", payload: { text: "hi" } },
    });
  });

  it("decodes a control event with no payload", () => {
    const result = decodeControlEvent(line({ type: "control_event", subtype: "session_started" }));
    expect(result.ok).toBe(true);
  });

  it("fails closed on invalid JSON", () => {
    expect(decodeControlEvent("{not json")).toEqual({ ok: false });
  });

  it("fails closed on non-object JSON (array, number, null, string)", () => {
    expect(decodeControlEvent(line([1, 2, 3])).ok).toBe(false);
    expect(decodeControlEvent(line(42)).ok).toBe(false);
    expect(decodeControlEvent(line(null)).ok).toBe(false);
    expect(decodeControlEvent(line("a string")).ok).toBe(false);
  });

  it("fails closed on the wrong frame type", () => {
    expect(decodeControlEvent(line({ type: "control_request", subtype: "prompt" })).ok).toBe(false);
  });

  it("fails closed on a missing or blank subtype", () => {
    expect(decodeControlEvent(line({ type: "control_event" })).ok).toBe(false);
    expect(decodeControlEvent(line({ type: "control_event", subtype: "" })).ok).toBe(false);
    expect(decodeControlEvent(line({ type: "control_event", subtype: 7 })).ok).toBe(false);
  });
});

describe("isWorkerStatusEvent", () => {
  it("recognizes each known worker status", () => {
    for (const status of ["running", "requires_action", "idle"]) {
      expect(isWorkerStatusEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status } })).toBe(true);
    }
  });

  it("rejects a non-worker_status subtype", () => {
    expect(isWorkerStatusEvent({ subtype: "message", payload: { status: "running" } })).toBe(false);
  });

  it("rejects a worker_status frame with a missing, malformed, or unknown status", () => {
    expect(isWorkerStatusEvent({ subtype: WORKER_STATUS_SUBTYPE })).toBe(false);
    expect(isWorkerStatusEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: null })).toBe(false);
    expect(isWorkerStatusEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: [1] })).toBe(false);
    expect(isWorkerStatusEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "sleeping" } })).toBe(false);
  });
});

describe("activityText", () => {
  it("labels running and idle", () => {
    expect(activityText("running")).toBe("Running…");
    expect(activityText("idle")).toBe("Idle");
  });

  it("surfaces the requires_action detail when present", () => {
    expect(activityText("requires_action", "Approve tool use?")).toBe("Approve tool use?");
  });

  it("falls back to the default detail when requires_action carries none or a blank one", () => {
    expect(activityText("requires_action")).toBe(DEFAULT_REQUIRES_ACTION_DETAIL);
    expect(activityText("requires_action", "   ")).toBe(DEFAULT_REQUIRES_ACTION_DETAIL);
    expect(activityText("requires_action", 5)).toBe(DEFAULT_REQUIRES_ACTION_DETAIL);
  });
});

describe("activityFromEvent", () => {
  it("derives the activity of a worker_status frame (sequenceNum null when the frame carries none)", () => {
    expect(activityFromEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "running" } })).toEqual({
      status: "running",
      text: "Running…",
      sequenceNum: null,
    });
    expect(
      activityFromEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "requires_action", detail: "Pick one" } }),
    ).toEqual({ status: "requires_action", text: "Pick one", sequenceNum: null });
  });

  it("carries the block's #201 sequence_num (the #87 enrichment join key) when present", () => {
    expect(
      activityFromEvent({
        subtype: WORKER_STATUS_SUBTYPE,
        payload: { status: "requires_action", detail: "Pick one", sequence_num: 7 },
      }),
    ).toEqual({ status: "requires_action", text: "Pick one", sequenceNum: 7 });
    // Sequence 0 is the first stamp of an epoch — a real value, not "absent".
    expect(
      activityFromEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "requires_action", sequence_num: 0 } })
        .sequenceNum,
    ).toBe(0);
  });

  it("reads a malformed sequence_num as null (no usable ordering signal — the join then fails safe)", () => {
    for (const bad of [-1, 1.5, "7", Number.NaN, null]) {
      expect(
        activityFromEvent({
          subtype: WORKER_STATUS_SUBTYPE,
          payload: { status: "requires_action", sequence_num: bad },
        }).sequenceNum,
      ).toBeNull();
    }
  });

  it("returns null for a non-worker_status event", () => {
    expect(activityFromEvent({ subtype: "message", payload: { text: "hi" } })).toBeNull();
  });
});

describe("summarizePayload", () => {
  it("prefers a text field, then a message field", () => {
    expect(summarizePayload({ text: "hello" })).toBe("hello");
    expect(summarizePayload({ message: "world" })).toBe("world");
  });

  it("renders compact JSON for other payload shapes", () => {
    expect(summarizePayload({ tool: "bash", ok: true })).toBe('{"tool":"bash","ok":true}');
  });

  it("summarizes an absent or non-object payload to the empty string", () => {
    expect(summarizePayload(undefined)).toBe("");
    expect(summarizePayload(null)).toBe("");
  });
});

describe("formatTranscriptEntry", () => {
  it("labels the entry with its subtype and summarizes the payload", () => {
    expect(formatTranscriptEntry({ subtype: "message", payload: { text: "hi there" } })).toEqual({
      subtype: "message",
      summary: "hi there",
    });
    expect(formatTranscriptEntry({ subtype: "session_started" })).toEqual({
      subtype: "session_started",
      summary: "",
    });
  });
});

describe("processEventData", () => {
  it("routes a worker_status frame to an activity instruction (carrying its sequenceNum, #87 join key)", () => {
    expect(
      processEventData(line({ type: "control_event", subtype: "worker_status", payload: { status: "idle" } })),
    ).toEqual({
      kind: "activity",
      status: "idle",
      text: "Idle",
      sequenceNum: null,
    });
    expect(
      processEventData(
        line({
          type: "control_event",
          subtype: "worker_status",
          payload: { status: "requires_action", detail: "Pick one", sequence_num: 9 },
        }),
      ),
    ).toEqual({ kind: "activity", status: "requires_action", text: "Pick one", sequenceNum: 9 });
  });

  it("routes any other control event to a transcript instruction", () => {
    expect(processEventData(line({ type: "control_event", subtype: "message", payload: { text: "hi" } }))).toEqual({
      kind: "transcript",
      subtype: "message",
      summary: "hi",
    });
  });

  it("routes an undecodable line to an unparsed instruction, verbatim", () => {
    expect(processEventData("{broken")).toEqual({ kind: "unparsed", raw: "{broken" });
  });

  it("routes the server's terminal frame to a closed instruction, carrying its human line (#196)", () => {
    expect(processEventData(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "closed" }))).toEqual(
      { kind: "closed", status: "closed", text: "Session ended." },
    );
  });

  it("carries an `errored` terminal status through to its own line (#196)", () => {
    expect(
      processEventData(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "errored" })),
    ).toEqual({ kind: "closed", status: "errored", text: "Session ended — errored." });
  });
});

describe("decodeSessionClosed — the server's terminal frame (#196)", () => {
  // Rule: the page acts on this frame by closing its own stream and telling the operator the session is
  // over. Both are irreversible-looking to a watching human, so the frame must be exactly right or not
  // this frame at all: an `unparsed` blob is a line they can read, while a loose decode announces a live
  // session dead.

  it("decodes a well-formed terminal frame", () => {
    expect(
      decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "closed" })),
    ).toEqual({ status: "closed" });
  });

  it("decodes an `errored` terminal frame — the diagnosis the server preserved reaches the watcher", () => {
    expect(
      decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "errored" })),
    ).toEqual({ status: "errored" });
  });

  it("fails closed on invalid JSON", () => {
    expect(decodeSessionClosed("{not json")).toBeNull();
  });

  it("fails closed on non-object JSON (array, number, null, string)", () => {
    expect(decodeSessionClosed(line([1, 2, 3]))).toBeNull();
    expect(decodeSessionClosed(line(42))).toBeNull();
    expect(decodeSessionClosed(line(null))).toBeNull();
    expect(decodeSessionClosed(line("closed"))).toBeNull();
  });

  it("fails closed on another frame's type — a worker's control event is never a terminal frame", () => {
    expect(decodeSessionClosed(line({ type: "control_event", subtype: "message" }))).toBeNull();
    // Its own `ccctl_` siblings are not it either: the namespace is shared, the `type` is the discriminant.
    expect(decodeSessionClosed(line({ type: "ccctl_session_idle", session_id: "sess-1" }))).toBeNull();
  });

  it("fails closed on a NON-terminal status — a session cannot end as `ready`", () => {
    // The frame's whole claim is that the session is OVER. A status outside the terminal set means the
    // sender and this reader disagree about what the frame means, and the safe reading of a disagreement
    // is not "it ended anyway".
    expect(decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "s", status: "ready" }))).toBeNull();
    expect(
      decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "s", status: "registering" })),
    ).toBeNull();
  });

  it("fails closed on a missing / blank / non-string status", () => {
    expect(decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "s" }))).toBeNull();
    expect(decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "s", status: "" }))).toBeNull();
    expect(decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, session_id: "s", status: 1 }))).toBeNull();
  });

  it("does not require a `session_id` — the per-session stream already named it (#20)", () => {
    // Deliberate: the frame arrived on the only stream it could have. Requiring the id would invite
    // trusting a self-reported one over the channel it came in on.
    expect(decodeSessionClosed(line({ type: SESSION_CLOSED_EVENT_TYPE, status: "closed" }))).toEqual({
      status: "closed",
    });
  });
});

describe("closedText", () => {
  it("says the session ended", () => {
    expect(closedText("closed")).toBe("Session ended.");
  });

  it("says HOW it ended when it errored — a failure and a stop are different news", () => {
    expect(closedText("errored")).toBe("Session ended — errored.");
  });
});
