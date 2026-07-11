// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The worker-channel WebSocket — bridge-protocol §2/§3 (the server side).
 *
 * `@ccctl/server` mints a `ws_url` pointing at its OWN bound address
 * (`ws://host:port/v1/code/sessions/{id}/ws`), so the ccctl server IS the
 * WebSocket server: the patched worker (or, in tests, a client stand-in) dials in
 * and streams `stream-json` frames server-ward. This module accepts that upgrade
 * and reads the channel; "the server opens the worker WebSocket at ws_url" (AC-1)
 * is the server standing up that endpoint.
 *
 * What this slice does — and only this (AC-3: "just reads and surfaces the raw
 * state"):
 *   1. Accept the WebSocket upgrade at `…/{sessionId}/ws` for a known session,
 *      requiring the account Bearer on the connect (bridge-protocol §4) and
 *      failing closed otherwise. The Bearer is a strict NON-PERSISTING
 *      pass-through — validated for receipt via {@link parseBearer}, then dropped;
 *      it never reaches session state or a log.
 *   2. Decode the inbound WebSocket text frames ({@link WsFrameReader}) into their
 *      NDJSON payload and feed that to `@ccctl/core`'s streaming
 *      {@link ControlFrameDecoder} — the framing and the control-frame codec are
 *      both reused, never re-implemented here.
 *   3. Apply each decoded frame with `@ccctl/core`'s pure
 *      {@link applyWorkerStatusFrame}: a `worker_status` frame advances the
 *      session's `activity` (running / requires_action / idle); anything else is a
 *      no-op. The surfaced state is the session in {@link WorkerChannelState.sessions}.
 *
 * Transport lifecycle: opening the channel moves the session `status` from
 * `connecting` to `ready`; a WebSocket close, a socket error, or a bare TCP
 * half-close (a FIN without a Close frame) all move it to `closed` and reap the
 * channel. One channel per session — a second concurrent upgrade is refused with a
 * 409, mirroring the register's one-session rule — and reaping frees that slot so a
 * reconnect after a clean or abrupt disconnect is accepted. `activity` and `status`
 * are the independent dimensions the core model defines, updated separately here.
 * Classification beyond the raw tri-state and the idle timer are later items.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  applyWorkerStatusFrame,
  ControlFrameDecoder,
  encodeControlFrame,
  SESSIONS_CREATE_PATH,
  SESSIONS_PATH,
  type ControlRequest,
  type Session,
  type SessionStatus,
} from "@ccctl/core";
import { parseBearer } from "./bearer.js";
import { broadcastEvent, type EventStreamState } from "./event-stream.js";
import {
  closeFramePayload,
  computeAcceptKey,
  encodeWsFrame,
  WsFrameReader,
  WsOpcode,
  type WsFrame,
} from "./websocket.js";

/** RFC 6455 §7.4.1 close codes this slice sends. */
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_PROTOCOL_ERROR = 1002;

/** The per-server state the worker channel reads and updates. */
export interface WorkerChannelState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: Map<string, Session>;
  /**
   * The live worker-channel socket per session id, so the server can enforce one
   * channel per session and tear the socket down on shutdown. An upgraded socket is
   * detached from the HTTP server and is not reachable via its connection-management
   * APIs, so ownership is explicit here.
   */
  readonly workerChannels: Map<string, Duplex>;
  /**
   * The UI Server-Sent Events relay state. Every inbound `control_event` read off
   * this channel is fanned out to subscribed UI clients through it (#13), so the
   * read path is also the source of the browser's event stream.
   */
  readonly events: EventStreamState;
}

/**
 * Handle one HTTP `upgrade` against the worker-channel contract. Fails closed —
 * writing a plain HTTP error and destroying the socket — on every branch that is
 * not a well-formed WebSocket upgrade for a KNOWN session carrying the account
 * Bearer. On success it completes the RFC 6455 handshake and reads the channel,
 * surfacing each `worker_status` frame into the session's `activity`.
 */
export function handleWorkerChannelUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  state: WorkerChannelState,
): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const sessionId = matchWorkerChannelPath(pathname);
  if (sessionId === null) {
    rejectUpgrade(socket, 404, "Not Found", `ccctl: no worker channel for ${pathname}`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    rejectUpgrade(socket, 404, "Not Found", `ccctl: no session ${sessionId}`);
    return;
  }
  // Bridge-protocol §4: the account Bearer is presented AGAIN on the worker-WS
  // connect. Require it and fail closed if absent/malformed — the security posture
  // forbids an unauthenticated channel, even on loopback. Non-persisting: the
  // parsed token is compared to null and discarded, never stored or logged.
  if (parseBearer(req.headers.authorization) === null) {
    rejectUpgrade(socket, 401, "Unauthorized", "ccctl: missing or malformed `Authorization: Bearer` credential", {
      "WWW-Authenticate": "Bearer",
    });
    return;
  }
  // One worker channel per session at this slice: a session already streaming a
  // live channel refuses a second concurrent upgrade rather than letting two
  // channels race the same session's state. Mirrors the register "one session only"
  // 409; a cleanly- or abruptly-closed channel is reaped (see `shutdown` /the `end`
  // handler), freeing the slot for a reconnect.
  if (state.workerChannels.has(sessionId)) {
    rejectUpgrade(socket, 409, "Conflict", `ccctl: session ${sessionId} already has a worker channel`);
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    rejectUpgrade(socket, 400, "Bad Request", "ccctl: malformed WebSocket upgrade");
    return;
  }

  // Complete the RFC 6455 §4.2.2 handshake; from here the socket carries frames.
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
  );
  setStatus(state, sessionId, "ready");
  // Own the socket, keyed by session, for the one-channel guard above and for
  // shutdown teardown (it is now detached from the HTTP server).
  state.workerChannels.set(sessionId, socket);

  // One NDJSON decoder and one frame reader per connection: both buffer across
  // chunk boundaries, so a control line or a WebSocket frame split over two socket
  // reads is reassembled, never mis-parsed.
  const decoder = new ControlFrameDecoder();
  const reader = new WsFrameReader();
  let messageOpcode: number | null = null;
  let messageChunks: Buffer[] = [];
  let closed = false;

  // Deferred hardening: only the per-frame 16 MiB cap (WsFrameReader) bounds inbound
  // bytes — the reassembly buffer here and core's ControlFrameDecoder buffer both
  // accumulate across fragments/reads without an AGGREGATE cap, so a flood of
  // sub-cap fragments (or an unterminated NDJSON line) could grow memory unbounded.
  // The channel is loopback-only and speaks to a trusted patched worker, so this is
  // defense-in-depth, not an exploit path; an aggregate cap (spanning core's decoder)
  // lands with the liveness/idle-timer item.

  const shutdown = (): void => {
    if (!closed) {
      closed = true;
      // Only reap the mapping if it still points at THIS socket, so a late
      // shutdown of a prior socket can never evict a reconnect's live channel.
      if (state.workerChannels.get(sessionId) === socket) {
        state.workerChannels.delete(sessionId);
      }
      setStatus(state, sessionId, "closed");
    }
  };

  const applyLines = (text: string): void => {
    for (const result of decoder.push(text)) {
      // Malformed NDJSON lines are skipped: a bad line must not tear the channel
      // down (the fail-closed-per-line policy the core decoder is built for).
      if (!result.ok) {
        continue;
      }
      const frame = result.frame;
      // A `worker_status` frame advances the session's derived activity; any other
      // frame is a no-op inside applyWorkerStatusFrame.
      const session = state.sessions.get(sessionId);
      if (session !== undefined) {
        state.sessions.set(sessionId, applyWorkerStatusFrame(session, frame));
      }
      // Relay every control_event to subscribed UI clients over SSE (#13) — the
      // read-path counterpart of the worker-ward steer relay below. State events
      // (`worker_status`) and transcript events alike fan out to the browser; a
      // control_request / control_response is not an "event" and is not relayed
      // (broadcast is ControlEvent-typed).
      if (frame.type === "control_event") {
        broadcastEvent(state.events, frame);
      }
    }
  };

  const finishMessage = (): void => {
    const opcode = messageOpcode;
    const message = Buffer.concat(messageChunks);
    messageOpcode = null;
    messageChunks = [];
    // The worker channel speaks UTF-8 text NDJSON; a stray binary message is
    // dropped rather than mis-decoded as text.
    if (opcode === WsOpcode.Text) {
      applyLines(message.toString("utf8"));
    }
  };

  const onData = (chunk: Buffer): void => {
    let frames: WsFrame[];
    try {
      frames = reader.push(chunk);
    } catch {
      // A framing protocol error: close with 1002 and tear down rather than act
      // on a malformed frame.
      socket.end(encodeWsFrame(WsOpcode.Close, closeFramePayload(WS_CLOSE_PROTOCOL_ERROR)));
      shutdown();
      return;
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case WsOpcode.Close:
          socket.end(encodeWsFrame(WsOpcode.Close, closeFramePayload(WS_CLOSE_NORMAL)));
          shutdown();
          return;
        case WsOpcode.Ping:
          socket.write(encodeWsFrame(WsOpcode.Pong, frame.payload));
          break;
        case WsOpcode.Pong:
          break; // an unsolicited pong: ignore.
        case WsOpcode.Text:
        case WsOpcode.Binary:
          messageOpcode = frame.opcode;
          messageChunks = [frame.payload];
          if (frame.fin) {
            finishMessage();
          }
          break;
        case WsOpcode.Continuation:
          messageChunks.push(frame.payload);
          if (frame.fin) {
            finishMessage();
          }
          break;
        default:
          break; // unreachable: the reader rejects unknown opcodes.
      }
    }
  };

  socket.on("data", onData);
  socket.on("close", shutdown);
  socket.on("error", () => {
    socket.destroy();
    shutdown();
  });
  // A worker that half-closes (sends a TCP FIN) without a WebSocket Close frame
  // would otherwise linger: 'close' never fires while the server's write side stays
  // open, so the session would be stuck `ready` and its one-channel slot held until
  // restart. Treat the peer's FIN as a disconnect — destroy the socket, which drives
  // 'close' → shutdown → status `closed` and reaps the slot.
  socket.on("end", () => {
    socket.destroy();
  });

  // Any bytes the HTTP parser already read past the handshake headers arrive in
  // `head`; feed them before yielding to the socket's own 'data' stream.
  if (head.length > 0) {
    onData(head);
  }
}

/**
 * Relay one steer message worker-ward over an open worker channel — the write
 * counterpart to the read path above (bridge-protocol §2: "steer input flows
 * worker-ward over this one channel"). Looks up the session's live worker-channel
 * socket, serializes the {@link ControlRequest} to its NDJSON line with
 * `@ccctl/core`'s {@link encodeControlFrame} — the SAME codec the read path decodes,
 * so the framing stays symmetric and is never re-implemented — and writes it as a
 * single UNMASKED WebSocket text frame ({@link encodeWsFrame}, server→client per
 * RFC 6455 §5.1). The trailing newline `encodeControlFrame` appends is the NDJSON
 * delimiter that lets the worker's own decoder emit the line without buffering.
 *
 * Fails closed: a session with no live channel (never connected, or already reaped)
 * throws rather than silently dropping the steer — {@link WorkerChannelState.workerChannels}
 * is the source of truth for a live channel, so its absence IS "not connected". The
 * UI-facing caller (`CcctlServer.dispatch`) surfaces that to the UI.
 */
export function dispatchToWorkerChannel(state: WorkerChannelState, sessionId: string, request: ControlRequest): void {
  const socket = state.workerChannels.get(sessionId);
  if (socket === undefined) {
    throw new Error(`ccctl: no live worker channel for session ${sessionId}`);
  }
  socket.write(encodeWsFrame(WsOpcode.Text, Buffer.from(encodeControlFrame(request), "utf8")));
}

/**
 * The worker-channel path bases a `ws_url` may be minted under: the current flow's
 * session-create ({@link SESSIONS_PATH} → `/v1/sessions/{id}/ws`) and the retained
 * legacy register ({@link SESSIONS_CREATE_PATH} → `/v1/code/sessions/{id}/ws`).
 * Neither is a prefix of the other, so match order is irrelevant.
 */
const WORKER_CHANNEL_PATH_BASES: readonly string[] = [SESSIONS_PATH, SESSIONS_CREATE_PATH];

/**
 * Extract the session id from a worker-channel path (`{base}/{sessionId}/ws`, for a
 * base in {@link WORKER_CHANNEL_PATH_BASES}), or `null` when the path is not a
 * worker-channel URL or carries an empty / nested session segment.
 */
function matchWorkerChannelPath(pathname: string): string | null {
  const suffix = "/ws";
  if (!pathname.endsWith(suffix)) {
    return null;
  }
  for (const base of WORKER_CHANNEL_PATH_BASES) {
    const prefix = `${base}/`;
    if (pathname.startsWith(prefix)) {
      const sessionId = pathname.slice(prefix.length, pathname.length - suffix.length);
      return sessionId === "" || sessionId.includes("/") ? null : sessionId;
    }
  }
  return null;
}

/** Update a session's transport-lifecycle `status`, leaving its other dimensions untouched. */
function setStatus(state: WorkerChannelState, sessionId: string, status: SessionStatus): void {
  const session = state.sessions.get(sessionId);
  if (session !== undefined) {
    state.sessions.set(sessionId, { ...session, status });
  }
}

/** Reject an upgrade with a minimal plain-HTTP error, then destroy the socket. */
function rejectUpgrade(
  socket: Duplex,
  status: number,
  statusText: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  const lines = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(message)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n${message}`);
  socket.destroy();
}
