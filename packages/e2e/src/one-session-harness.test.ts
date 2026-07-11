// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { encodeControlFrame, type ControlRequest } from "@ccctl/core";
import { maskWsTextFrame, parseSseBlock, readServerTextFrames } from "./one-session-harness.js";

// Unit coverage of the harness's pure WebSocket/SSE framing helpers — the pieces
// that MIRROR the server codec on the client side. They are exercised end-to-end
// against the real server in `one-session-flow.e2e.test.ts`; here we drive them
// directly so the framing is verified on every `test` run without a live server.

/** Decode one masked (client→server) frame the way the SERVER would, to verify `maskWsTextFrame`. */
function decodeMaskedFrame(frame: Buffer): { fin: boolean; masked: boolean; opcode: number; text: string } {
  const b0 = frame.readUInt8(0);
  const b1 = frame.readUInt8(1);
  let length = b1 & 0x7f;
  let maskOffset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(2);
    maskOffset = 4;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(2));
    maskOffset = 10;
  }
  const mask = frame.subarray(maskOffset, maskOffset + 4);
  const dataOffset = maskOffset + 4;
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    out.writeUInt8(frame.readUInt8(dataOffset + i) ^ mask.readUInt8(i % 4), i);
  }
  return { fin: (b0 & 0x80) !== 0, masked: (b1 & 0x80) !== 0, opcode: b0 & 0x0f, text: out.toString("utf8") };
}

/** Build an UNMASKED (server→client) text frame, to feed `readServerTextFrames`. */
function unmaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header.writeUInt8(0x81, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(0x81, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

describe("maskWsTextFrame — client→server framing (RFC 6455 §5.1)", () => {
  it("encodes a masked, FIN, text frame that round-trips to the original text", () => {
    const decoded = decodeMaskedFrame(maskWsTextFrame("hi from the worker"));
    expect(decoded).toEqual({ fin: true, masked: true, opcode: 0x1, text: "hi from the worker" });
  });

  it("masks a large payload with the 16-bit extended length form (>126 bytes)", () => {
    const text = "x".repeat(500);
    const decoded = decodeMaskedFrame(maskWsTextFrame(text));
    expect(decoded.masked).toBe(true);
    expect(decoded.opcode).toBe(0x1);
    expect(decoded.text).toBe(text);
  });

  it("carries an encoded control frame verbatim", () => {
    const line = encodeControlFrame({ type: "control_event", subtype: "message", payload: { text: "hello" } });
    expect(decodeMaskedFrame(maskWsTextFrame(line)).text).toBe(line);
  });
});

describe("readServerTextFrames — server→client framing (RFC 6455 §5.1)", () => {
  it("decodes a single text frame", () => {
    expect(readServerTextFrames(unmaskedTextFrame("one"))).toEqual(["one"]);
  });

  it("decodes several frames buffered together, in order", () => {
    const buffer = Buffer.concat([unmaskedTextFrame("a"), unmaskedTextFrame("b"), unmaskedTextFrame("c")]);
    expect(readServerTextFrames(buffer)).toEqual(["a", "b", "c"]);
  });

  it("decodes a frame that needs the 16-bit extended length form (>126 bytes)", () => {
    const text = "y".repeat(1000);
    expect(readServerTextFrames(unmaskedTextFrame(text))).toEqual([text]);
  });

  it("returns only the complete frames, leaving a partial trailing frame for later", () => {
    const whole = unmaskedTextFrame("complete");
    const partial = unmaskedTextFrame("incomplete").subarray(0, 3); // header + a byte, no full payload.
    expect(readServerTextFrames(Buffer.concat([whole, partial]))).toEqual(["complete"]);
  });

  it("recovers a relayed control_request round-tripped through the frame", () => {
    const request: ControlRequest = { type: "control_request", id: "s1", subtype: "prompt", payload: { text: "go" } };
    const frame = unmaskedTextFrame(encodeControlFrame(request));
    const [line] = readServerTextFrames(frame);
    expect(JSON.parse(String(line).trimEnd())).toEqual(request);
  });

  it("throws on a masked server frame (a protocol violation)", () => {
    const masked = unmaskedTextFrame("nope");
    masked.writeUInt8(masked.readUInt8(1) | 0x80, 1); // set the mask bit the server must never set.
    expect(() => readServerTextFrames(masked)).toThrow(/masked/);
  });
});

describe("parseSseBlock — EventSource block parsing", () => {
  it("parses an id + data block into a viewed event", () => {
    expect(parseSseBlock('id: 1\ndata: {"a":1}')).toEqual({ id: "1", data: '{"a":1}' });
  });

  it("returns null for a comment-only block (the stream opener / keep-alive)", () => {
    expect(parseSseBlock(": ccctl event stream")).toBeNull();
  });

  it("joins a multi-line data field, honoring the id", () => {
    expect(parseSseBlock("id: 2\ndata: line1\ndata: line2")).toEqual({ id: "2", data: "line1\nline2" });
  });

  it("leaves id undefined when the block carries no id", () => {
    expect(parseSseBlock("data: hi")).toEqual({ id: undefined, data: "hi" });
  });
});
