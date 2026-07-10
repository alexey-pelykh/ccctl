// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  ControlFrameDecoder,
  ControlFrameParseError,
  decodeControlFrame,
  encodeControlFrame,
  type ControlEvent,
  type ControlFrame,
  type ControlRequest,
  type ControlResponse,
  type DecodeResult,
} from "./index.js";

const request: ControlRequest = {
  type: "control_request",
  id: "req-1",
  subtype: "prompt",
  payload: { text: "hello", nested: { n: 1, flag: true } },
};

const response: ControlResponse = {
  type: "control_response",
  id: "req-1",
  ok: true,
  result: { accepted: true },
};

const errorResponse: ControlResponse = {
  type: "control_response",
  id: "req-2",
  ok: false,
  error: "interrupt refused",
};

const event: ControlEvent = {
  type: "control_event",
  subtype: "session_started",
  payload: { sessionId: "s-1" },
};

/** Assert a result is a successful decode and return the frame (fails the test otherwise). */
function expectFrame(result: DecodeResult | null | undefined): ControlFrame {
  expect(result?.ok).toBe(true);
  if (!result?.ok) {
    throw new Error("expected a decoded frame");
  }
  return result.frame;
}

/** Assert a result is a parse failure and return the typed error (fails the test otherwise). */
function expectError(result: DecodeResult | null | undefined): ControlFrameParseError {
  expect(result?.ok).toBe(false);
  if (!result || result.ok) {
    throw new Error("expected a parse failure");
  }
  return result.error;
}

describe("encodeControlFrame", () => {
  it("emits exactly one `\\n`-terminated NDJSON line", () => {
    const line = encodeControlFrame(request);
    expect(line.endsWith("\n")).toBe(true);
    // Exactly one newline, and it is the terminator.
    expect(line.indexOf("\n")).toBe(line.length - 1);
  });

  it("serializes to parseable JSON with no embedded newline", () => {
    const line = encodeControlFrame(response);
    const body = line.slice(0, -1);
    expect(body).not.toContain("\n");
    expect(JSON.parse(body)).toEqual(response);
  });
});

describe("decodeControlFrame round-trip", () => {
  it.each<[string, ControlFrame]>([
    ["control_request", request],
    ["control_response (ok)", response],
    ["control_response (error)", errorResponse],
    ["control_event", event],
  ])("round-trips a %s frame to identity", (_label, frame) => {
    expect(expectFrame(decodeControlFrame(encodeControlFrame(frame)))).toEqual(frame);
  });

  it("decodes a line whose `\\n` terminator was already stripped", () => {
    const line = encodeControlFrame(request).replace(/\n$/, "");
    expect(expectFrame(decodeControlFrame(line))).toEqual(request);
  });
});

describe("decodeControlFrame typed parse errors", () => {
  it("never throws on malformed input", () => {
    expect(() => decodeControlFrame("{ not json")).not.toThrow();
    expect(() => decodeControlFrame("")).not.toThrow();
  });

  it.each<[string, string, ControlFrameParseError["reason"]]>([
    ["broken JSON", "{ not json", "invalid-json"],
    ["empty line", "", "invalid-json"],
    ["a JSON number", "42", "not-an-object"],
    ["a JSON string", '"control_request"', "not-an-object"],
    ["JSON null", "null", "not-an-object"],
    ["a JSON array", '[{"type":"control_request"}]', "not-an-object"],
    ["object without a type", '{"id":"x"}', "missing-type"],
    ["unknown discriminator", '{"type":"control_ping","id":"x"}', "unknown-type"],
  ])("surfaces %s as reason %s", (_label, line, reason) => {
    const result = decodeControlFrame(line);
    const error = expectError(result);
    expect(error).toBeInstanceOf(ControlFrameParseError);
    expect(error.reason).toBe(reason);
    // The offending line is preserved for diagnostics, and the message is namespaced.
    expect(error.line).toBe(line);
    expect(error.message).toContain("ccctl:");
  });
});

describe("ControlFrameDecoder streaming", () => {
  it("emits one result per complete line in a multi-frame chunk", () => {
    const decoder = new ControlFrameDecoder();
    const chunk = encodeControlFrame(request) + encodeControlFrame(response);
    const results = decoder.push(chunk);
    expect(results).toHaveLength(2);
    expect(expectFrame(results[0])).toEqual(request);
    expect(expectFrame(results[1])).toEqual(response);
  });

  it("buffers a partial line across chunk boundaries without erroring", () => {
    const decoder = new ControlFrameDecoder();
    const line = encodeControlFrame(request); // includes trailing "\n"
    const split = 12;

    // First half has no newline yet: nothing is emitted, nothing errors.
    expect(decoder.push(line.slice(0, split))).toEqual([]);

    // Second half completes the line: exactly one frame, reassembled to identity.
    const results = decoder.push(line.slice(split));
    expect(results).toHaveLength(1);
    expect(expectFrame(results[0])).toEqual(request);
  });

  it("reassembles a frame delivered one character at a time", () => {
    const decoder = new ControlFrameDecoder();
    const line = encodeControlFrame(event);
    const emitted: DecodeResult[] = [];
    for (const ch of line) {
      emitted.push(...decoder.push(ch));
    }
    expect(emitted).toHaveLength(1);
    expect(expectFrame(emitted[0])).toEqual(event);
  });

  it("keeps well-formed lines around a malformed one alive", () => {
    const decoder = new ControlFrameDecoder();
    const chunk = encodeControlFrame(request) + "{ broken\n" + encodeControlFrame(response);
    const results = decoder.push(chunk);
    expect(results).toHaveLength(3);
    expect(expectFrame(results[0])).toEqual(request);
    expect(expectError(results[1]).reason).toBe("invalid-json");
    expect(expectFrame(results[2])).toEqual(response);
  });

  it("skips blank / keep-alive lines instead of reporting them as errors", () => {
    const decoder = new ControlFrameDecoder();
    const chunk = "\n" + encodeControlFrame(request) + "\n\n";
    const results = decoder.push(chunk);
    expect(results).toHaveLength(1);
    expect(expectFrame(results[0])).toEqual(request);
  });

  it("flush() decodes a trailing line that never got its newline", () => {
    const decoder = new ControlFrameDecoder();
    const line = encodeControlFrame(request).replace(/\n$/, "");
    expect(decoder.push(line)).toEqual([]);
    const flushed = decoder.flush();
    expect(flushed).not.toBeNull();
    expect(expectFrame(flushed)).toEqual(request);
  });

  it("flush() surfaces a malformed trailing line as a typed error, not a throw", () => {
    const decoder = new ControlFrameDecoder();
    expect(decoder.push("{ broken")).toEqual([]);
    expect(expectError(decoder.flush()).reason).toBe("invalid-json");
  });

  it("flush() returns null when nothing (or only whitespace) is buffered", () => {
    const decoder = new ControlFrameDecoder();
    expect(decoder.flush()).toBeNull();
    decoder.push("   ");
    expect(decoder.flush()).toBeNull();
  });
});
