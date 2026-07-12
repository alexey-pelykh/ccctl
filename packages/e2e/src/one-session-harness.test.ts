// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { parseClientEventData, parseSseBlock } from "./one-session-harness.js";

// Unit coverage of the harness's pure SSE parsing helpers — the pieces that read the
// server's Server-Sent-Events framing on the client side (the worker's held-open
// downstream and the phone's event stream, #130/#131). They are exercised end-to-end
// against the real server in `one-session-flow.e2e.test.ts`; here we drive them directly
// so the parsing is verified on every `test` run without a live server.

describe("parseSseBlock — EventSource block parsing (event / id / data)", () => {
  it("parses a named-event block carrying an id and data (the worker downstream frame)", () => {
    expect(parseSseBlock('event: client_event\nid: 1\ndata: {"a":1}')).toEqual({
      event: "client_event",
      id: "1",
      data: '{"a":1}',
    });
  });

  it("parses an id + data block with no event name (the phone's default-event frame)", () => {
    expect(parseSseBlock('id: 2\ndata: {"b":2}')).toEqual({ event: undefined, id: "2", data: '{"b":2}' });
  });

  it("returns null for a comment-only block (the stream opener / keep-alive)", () => {
    expect(parseSseBlock(": ccctl worker stream")).toBeNull();
    expect(parseSseBlock(": ccctl event stream")).toBeNull();
  });

  it("joins a multi-line data field, honoring the event and id", () => {
    expect(parseSseBlock("event: client_event\nid: 3\ndata: line1\ndata: line2")).toEqual({
      event: "client_event",
      id: "3",
      data: "line1\nline2",
    });
  });

  it("leaves event and id undefined when the block carries neither", () => {
    expect(parseSseBlock("data: hi")).toEqual({ event: undefined, id: undefined, data: "hi" });
  });
});

describe("parseClientEventData — the downstream turn-injection envelope", () => {
  const USER_TURN = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "continue please" }] },
    parent_tool_use_id: null,
    session_id: "sess-1",
    uuid: "uuid-1",
  };

  it("decodes a well-formed client_event envelope and returns its demux payload verbatim", () => {
    const data = JSON.stringify({ sequence_num: 1, event_id: "evt-1", event_type: "message", payload: USER_TURN });
    expect(parseClientEventData(data)).toEqual({ eventId: "evt-1", sequenceNum: 1, payload: USER_TURN });
  });

  it("carries a control_request payload through unchanged (the non-prompt demux branch)", () => {
    const controlRequest = { type: "control_request", id: "req-1", subtype: "interrupt", payload: { reason: "stop" } };
    const data = JSON.stringify({ sequence_num: 4, event_id: "evt-4", event_type: "message", payload: controlRequest });
    expect(parseClientEventData(data)?.payload).toEqual(controlRequest);
  });

  it("returns null for invalid JSON", () => {
    expect(parseClientEventData("not json")).toBeNull();
  });

  it("returns null when event_id, sequence_num, or payload is missing (fail closed)", () => {
    expect(
      parseClientEventData(JSON.stringify({ sequence_num: 1, event_type: "message", payload: USER_TURN })),
    ).toBeNull();
    expect(
      parseClientEventData(JSON.stringify({ event_id: "evt-1", event_type: "message", payload: USER_TURN })),
    ).toBeNull();
    expect(
      parseClientEventData(JSON.stringify({ sequence_num: 1, event_id: "evt-1", event_type: "message" })),
    ).toBeNull();
  });

  it("returns null for a non-object envelope", () => {
    expect(parseClientEventData("[]")).toBeNull();
    expect(parseClientEventData("null")).toBeNull();
  });
});
