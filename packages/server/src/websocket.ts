// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Minimal server-side WebSocket (RFC 6455) codec — the framing layer the
 * worker-channel rides on ({@link ./worker-channel.ts}).
 *
 * This is a deliberately small, read-oriented subset of RFC 6455: it is what a
 * ccctl server needs to accept ONE loopback worker connection and read its
 * `stream-json` frames — not a general-purpose WebSocket stack.
 *
 * Why hand-rolled rather than the `ws` package: `@ccctl/*` carries ZERO runtime
 * dependencies and is built on `node:*` primitives throughout (the register slice
 * hand-rolls its HTTP handling; `@ccctl/core` hand-rolls the NDJSON codec). Node
 * ships a WebSocket *client* (`globalThis.WebSocket`) but no server, and the
 * server-side, read-only path is a bounded, testable slice of the protocol. The
 * two protocol constants that must be exact — the handshake accept key and the
 * frame layout — are pinned against the RFC's own golden vectors in
 * `websocket.test.ts`, so a framing bug fails closed in CI rather than silently.
 *
 * Scope and fail-closed posture:
 *   - {@link computeAcceptKey} implements the §4.2.2 handshake response value.
 *   - {@link WsFrameReader} decodes inbound (client→server) frames, which RFC 6455
 *     §5.1 requires to be MASKED; an unmasked client frame is a protocol error and
 *     is rejected ({@link WsProtocolError}), never silently accepted.
 *   - {@link encodeWsFrame} builds the few small, UNMASKED (server→client) control
 *     frames the channel sends back (close, pong).
 *   - Extension/reserved bits are not negotiated and are ignored; an unknown
 *     opcode or an over-long payload fails closed.
 */

import { createHash } from "node:crypto";

/**
 * The RFC 6455 §1.3 GUID concatenated with `Sec-WebSocket-Key` before hashing to
 * form the `Sec-WebSocket-Accept` handshake response.
 */
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Hard ceiling on a single inbound frame's payload (16 MiB). The worker channel
 * carries tiny NDJSON control lines, so a frame claiming more than this is
 * treated as a protocol error rather than buffered — a bound against a malformed
 * or hostile length header allocating unbounded memory.
 */
const MAX_FRAME_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** RFC 6455 §5.2 opcodes, narrowed to the ones this codec handles. */
export const WsOpcode = {
  /** A continuation of a fragmented message. */
  Continuation: 0x0,
  /** A UTF-8 text data frame (what the worker channel carries). */
  Text: 0x1,
  /** A binary data frame (not used by the worker channel; read but ignored). */
  Binary: 0x2,
  /** A connection-close control frame. */
  Close: 0x8,
  /** A ping control frame. */
  Ping: 0x9,
  /** A pong control frame. */
  Pong: 0xa,
} as const;

/** One decoded inbound WebSocket frame (payload already unmasked). */
export interface WsFrame {
  /** Whether this frame is the final fragment of its message (the FIN bit). */
  readonly fin: boolean;
  /** The RFC 6455 opcode (see {@link WsOpcode}). */
  readonly opcode: number;
  /** The unmasked payload bytes. */
  readonly payload: Buffer;
}

/**
 * A non-fatal WebSocket protocol violation in an inbound frame (an unmasked
 * client frame, an unknown opcode, or an over-long payload). Thrown by
 * {@link WsFrameReader.push} so the caller tears the connection down with a
 * close rather than acting on a malformed frame.
 */
export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsProtocolError";
  }
}

/**
 * Compute the `Sec-WebSocket-Accept` response header value for a client's
 * `Sec-WebSocket-Key` (RFC 6455 §4.2.2): base64(SHA-1(key + GUID)). Pure and
 * deterministic; pinned against the RFC §1.3 example in the tests.
 */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1")
    .update(secWebSocketKey + WS_ACCEPT_GUID)
    .digest("base64");
}

/**
 * Encode a single UNMASKED server→client frame (RFC 6455 §5.1: server frames are
 * never masked). Scoped to the small control frames the worker channel emits
 * (close, pong), so it only handles payloads shorter than 126 bytes — the 7-bit
 * length form — which is all a close code or a pong echo needs.
 */
export function encodeWsFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length >= 126) {
    throw new WsProtocolError(`ccctl: encodeWsFrame handles only <126-byte control payloads, got ${payload.length}`);
  }
  const header = Buffer.alloc(2);
  header.writeUInt8(0x80 | opcode, 0); // FIN set; single-frame control message.
  header.writeUInt8(payload.length, 1); // no mask bit; 7-bit length.
  return Buffer.concat([header, payload]);
}

/**
 * Build the payload of a close frame: the 2-byte big-endian status code
 * (RFC 6455 §5.5.1). Pair with {@link encodeWsFrame} and {@link WsOpcode.Close}.
 */
export function closeFramePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

/**
 * Streaming decoder for inbound (client→server) WebSocket frames. Accepts raw
 * socket chunks and emits one {@link WsFrame} per COMPLETE frame, buffering a
 * partial frame across chunks (a frame split over two reads is never
 * mis-decoded). One reader per connection.
 *
 * It decodes the framing only — masking, length forms, opcode — and leaves
 * fragment reassembly (continuation frames) and control-frame semantics to the
 * caller, which has the message-level context. Client frames MUST be masked
 * (RFC 6455 §5.1); an unmasked frame, an unknown opcode, or an over-long payload
 * throws {@link WsProtocolError} so the caller fails the connection closed.
 */
export class WsFrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed the next socket chunk. Returns a {@link WsFrame} for every frame the
   * buffer now completes — possibly none (a partial frame is retained) or
   * several. Throws {@link WsProtocolError} on the first malformed frame.
   */
  push(chunk: Buffer): WsFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.#readFrame();
      if (frame === null) {
        return frames;
      }
      frames.push(frame);
    }
  }

  /**
   * Try to decode one frame off the front of the buffer. Returns the frame and
   * advances the buffer past it, or `null` when the buffer does not yet hold a
   * complete frame (leaving the buffer untouched for the next chunk).
   */
  #readFrame(): WsFrame | null {
    const buffer = this.#buffer;
    if (buffer.length < 2) {
      return null;
    }
    const b0 = buffer.readUInt8(0);
    const b1 = buffer.readUInt8(1);
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const length7 = b1 & 0x7f;

    // Resolve the payload length across the three RFC 6455 §5.2 forms, tracking
    // where the (client) mask key begins. Return null (wait for more bytes)
    // whenever an extended length field is not yet fully buffered.
    let payloadLength = length7;
    let maskOffset = 2;
    if (length7 === 126) {
      if (buffer.length < 4) {
        return null;
      }
      payloadLength = buffer.readUInt16BE(2);
      maskOffset = 4;
    } else if (length7 === 127) {
      if (buffer.length < 10) {
        return null;
      }
      const extended = buffer.readBigUInt64BE(2);
      if (extended > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
        throw new WsProtocolError(
          `ccctl: inbound WebSocket frame payload ${extended} exceeds the ${MAX_FRAME_PAYLOAD_BYTES}-byte cap`,
        );
      }
      payloadLength = Number(extended);
      maskOffset = 10;
    }
    if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) {
      throw new WsProtocolError(
        `ccctl: inbound WebSocket frame payload ${payloadLength} exceeds the ${MAX_FRAME_PAYLOAD_BYTES}-byte cap`,
      );
    }
    if (!masked) {
      throw new WsProtocolError(
        "ccctl: inbound WebSocket frame is not masked (RFC 6455 §5.1 requires client frames to be masked)",
      );
    }
    assertKnownOpcode(opcode);

    const dataOffset = maskOffset + 4;
    if (buffer.length < dataOffset + payloadLength) {
      return null; // full payload not yet buffered.
    }

    const payload = unmask(
      buffer.subarray(maskOffset, maskOffset + 4),
      buffer.subarray(dataOffset, dataOffset + payloadLength),
    );
    this.#buffer = buffer.subarray(dataOffset + payloadLength);
    return { fin, opcode, payload };
  }
}

/** Reject any opcode outside the set this codec knows how to handle. */
function assertKnownOpcode(opcode: number): void {
  switch (opcode) {
    case WsOpcode.Continuation:
    case WsOpcode.Text:
    case WsOpcode.Binary:
    case WsOpcode.Close:
    case WsOpcode.Ping:
    case WsOpcode.Pong:
      return;
    default:
      throw new WsProtocolError(`ccctl: unknown inbound WebSocket opcode 0x${opcode.toString(16)}`);
  }
}

/** XOR-unmask a payload with its 4-byte mask key (RFC 6455 §5.3), into a fresh buffer. */
function unmask(maskKey: Buffer, data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index++) {
    result.writeUInt8(data.readUInt8(index) ^ maskKey.readUInt8(index % 4), index);
  }
  return result;
}
