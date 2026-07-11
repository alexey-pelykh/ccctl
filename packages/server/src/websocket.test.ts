// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  closeFramePayload,
  computeAcceptKey,
  encodeWsFrame,
  WsFrameReader,
  WsOpcode,
  WsProtocolError,
} from "./websocket.js";

// Build a MASKED client frame with a FIXED mask key (0x01020304) — deliberately a
// different key than the RFC §5.7 golden below, so the reader is exercised against
// two independent maskings rather than one it could hard-code to.
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const first = (fin ? 0x80 : 0x00) | opcode;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([first, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header.writeUInt8(first, 0);
    header.writeUInt8(0x80 | 126, 1);
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

describe("computeAcceptKey", () => {
  it("computes the RFC 6455 §1.3 example accept key", () => {
    // The canonical example straight from the RFC — key in, accept out.
    expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("WsFrameReader", () => {
  it('decodes the RFC 6455 §5.7 single masked text frame ("Hello")', () => {
    // The exact golden bytes from the RFC: FIN+text, mask 0x37fa213d, "Hello".
    const rfcHello = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    const frames = new WsFrameReader().push(rfcHello);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.fin).toBe(true);
    expect(frames[0]?.opcode).toBe(WsOpcode.Text);
    expect(frames[0]?.payload.toString("utf8")).toBe("Hello");
  });

  it("reassembles a frame split across two pushes", () => {
    const frame = maskedFrame(WsOpcode.Text, Buffer.from("chunked", "utf8"));
    const reader = new WsFrameReader();
    // Split mid-header AND before the payload is complete: no frame until it is whole.
    expect(reader.push(frame.subarray(0, 3))).toHaveLength(0);
    expect(reader.push(frame.subarray(3, 6))).toHaveLength(0);
    const frames = reader.push(frame.subarray(6));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.toString("utf8")).toBe("chunked");
  });

  it("decodes several frames delivered in one chunk", () => {
    const a = maskedFrame(WsOpcode.Text, Buffer.from("one", "utf8"));
    const b = maskedFrame(WsOpcode.Text, Buffer.from("two", "utf8"));
    const frames = new WsFrameReader().push(Buffer.concat([a, b]));
    expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["one", "two"]);
  });

  it("decodes a 16-bit (126) extended-length payload", () => {
    const big = Buffer.alloc(200, 0x61); // 200 'a's — forces the 126 length form.
    const frames = new WsFrameReader().push(maskedFrame(WsOpcode.Text, big));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toHaveLength(200);
    expect(frames[0]?.payload.toString("utf8")).toBe(big.toString("utf8"));
  });

  it("carries the fin bit through a fragmented message (text then continuation)", () => {
    const first = maskedFrame(WsOpcode.Text, Buffer.from("frag-", "utf8"), false);
    const rest = maskedFrame(WsOpcode.Continuation, Buffer.from("ment", "utf8"), true);
    const frames = new WsFrameReader().push(Buffer.concat([first, rest]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.fin).toBe(false);
    expect(frames[0]?.opcode).toBe(WsOpcode.Text);
    expect(frames[1]?.fin).toBe(true);
    expect(frames[1]?.opcode).toBe(WsOpcode.Continuation);
  });

  it("fails closed on an unmasked client frame (RFC 6455 §5.1)", () => {
    // An unmasked text "Hi": FIN+text, no mask bit, len 2.
    const unmasked = Buffer.from([0x81, 0x02, 0x48, 0x69]);
    expect(() => new WsFrameReader().push(unmasked)).toThrow(WsProtocolError);
  });

  it("fails closed on an unknown opcode", () => {
    // Opcode 0x3 is a reserved non-control frame this codec does not handle.
    expect(() => new WsFrameReader().push(maskedFrame(0x3, Buffer.from("x", "utf8")))).toThrow(WsProtocolError);
  });
});

describe("encodeWsFrame / closeFramePayload", () => {
  it("encodes an unmasked close frame with a 2-byte status code", () => {
    const frame = encodeWsFrame(WsOpcode.Close, closeFramePayload(1000));
    // FIN+close (0x88), len 2 (no mask bit), then 0x03e8 = 1000 big-endian.
    expect([...frame]).toEqual([0x88, 0x02, 0x03, 0xe8]);
  });

  it("encodes an unmasked pong echoing its payload", () => {
    const frame = encodeWsFrame(WsOpcode.Pong, Buffer.from("pong", "utf8"));
    expect(frame[0]).toBe(0x8a); // FIN + pong opcode
    expect(frame[1]).toBe(0x04); // len 4, no mask bit
    expect(frame.subarray(2).toString("utf8")).toBe("pong");
  });

  it("encodes a 16-bit extended-length text frame at the 126-byte boundary", () => {
    const payload = Buffer.alloc(126, 0x61); // 126 'a's — the smallest 16-bit-length payload.
    const frame = encodeWsFrame(WsOpcode.Text, payload);
    // FIN+text (0x81), the 126 marker (0x7e, no mask bit), then the 16-bit length 0x007e.
    expect([...frame.subarray(0, 4)]).toEqual([0x81, 0x7e, 0x00, 0x7e]);
    expect(frame.subarray(4)).toEqual(payload);
  });

  it("encodes the 16-bit length ceiling (0xffff)", () => {
    const payload = Buffer.alloc(0xffff, 0x62);
    const frame = encodeWsFrame(WsOpcode.Text, payload);
    expect([...frame.subarray(0, 4)]).toEqual([0x81, 0x7e, 0xff, 0xff]);
    expect(frame.length).toBe(4 + 0xffff);
  });

  it("encodes a 64-bit extended-length text frame one past the 16-bit ceiling", () => {
    const payload = Buffer.alloc(0x10000, 0x63); // 65536 bytes — forces the 64-bit form.
    const frame = encodeWsFrame(WsOpcode.Text, payload);
    // FIN+text (0x81), the 127 marker (0x7f, no mask bit), then the 64-bit length 0x0000000000010000.
    expect([...frame.subarray(0, 10)]).toEqual([0x81, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
    expect(frame.subarray(10)).toEqual(payload);
  });
});
