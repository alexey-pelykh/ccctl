// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  DEFAULT_REQUIRES_ACTION_DETAIL,
  WORKER_STATUS_SUBTYPE,
  decodeControlEvent,
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
  it("derives the activity of a worker_status frame", () => {
    expect(activityFromEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "running" } })).toEqual({
      status: "running",
      text: "Running…",
    });
    expect(
      activityFromEvent({ subtype: WORKER_STATUS_SUBTYPE, payload: { status: "requires_action", detail: "Pick one" } }),
    ).toEqual({ status: "requires_action", text: "Pick one" });
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
  it("routes a worker_status frame to an activity instruction", () => {
    expect(
      processEventData(line({ type: "control_event", subtype: "worker_status", payload: { status: "idle" } })),
    ).toEqual({
      kind: "activity",
      status: "idle",
      text: "Idle",
    });
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
});
