// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The UI event stream — the Server-Sent Events (SSE) relay to the browser (#13).
 *
 * This is the downstream half of the zero-build UI transport pair: the worker
 * channel (`worker-channel.ts`) fans every inbound `control_event` out to
 * subscribed UI clients here, and the browser's `EventSource` reads them off
 * `GET /api/events`. The upstream half — the browser's `fetch` POST that steers
 * the worker — is `ui-command.ts`.
 *
 * What this slice guarantees:
 *   1. Every relayed event carries a monotonic **`Last-Event-ID`-compatible id**
 *      (SSE's `id:` field). EventSource replays the last id it saw on reconnect,
 *      so the id is what lets a client reconcile the gap it missed. Consuming that
 *      id in the UI / e2e is a later item (#15/#16/#19); the server-side seam —
 *      emitting the id AND replaying past it — lands here so the promise is real.
 *   2. A bounded per-stream **replay buffer**: on reconnect the server replays the
 *      retained events AFTER the client's `Last-Event-ID`, then goes live. A fresh
 *      connection (no cursor) is NOT replayed the backlog — it starts live.
 *
 * Single-session slice: the server tracks one session (the register / worker
 * channel both enforce it), so there is ONE event stream and every subscriber is
 * viewing that one session. Partitioning the stream per session — routing a
 * `broadcast` to only that session's subscribers — lands with multiplexing, a
 * later item; until then the one stream IS the one session's.
 *
 * Browser-facing auth is deferred: the loopback UI ingress is unauthenticated at
 * this slice (the account Bearer is the WORKER's credential, enforced on the
 * register + worker channel, never the browser's). The local-server credential
 * boundary — how the UI/tunnel authenticates — is the deferred security item.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlEvent } from "@ccctl/core";
import { writeError } from "./http-response.js";

/** The same-origin path the browser's `EventSource` subscribes to. */
export const EVENTS_PATH = "/api/events";

/**
 * How many recent events a stream retains for `Last-Event-ID` reconnect replay.
 * Bounded so a long-lived stream cannot grow memory without limit — a reconnect
 * older than this window replays only what is still retained (the oldest gap is
 * dropped), consistent with the codebase's fail-closed, bounded-buffer posture.
 * Control frames are tiny NDJSON lines, so 1024 covers a generous reconnect gap.
 */
const EVENT_REPLAY_BUFFER_SIZE = 1024;

/** One retained event: its id and its ready-to-write SSE chunk (encoded once). */
interface BufferedEvent {
  readonly id: number;
  readonly chunk: string;
}

/** The per-server SSE relay state: live subscribers plus the replay buffer. */
export interface EventStreamState {
  /** The open SSE responses (one per connected UI client). */
  readonly subscribers: Set<ServerResponse>;
  /** Recent events retained for `Last-Event-ID` reconnect replay (bounded). */
  readonly buffer: BufferedEvent[];
  /** The id the next relayed event will carry (monotonic, starts at 1). */
  nextEventId: number;
}

/** A fresh, empty relay state — one per server. */
export function createEventStreamState(): EventStreamState {
  return { subscribers: new Set<ServerResponse>(), buffer: [], nextEventId: 1 };
}

/**
 * Encode one control event as an SSE message carrying its `Last-Event-ID` `id`.
 * `JSON.stringify` never emits a literal newline (a newline inside a string is
 * escaped as `\n`), so the payload is a single physical line; the split still
 * defends the framing, since an SSE `data` field spanning newlines must repeat
 * the `data:` prefix per line.
 */
function encodeSseEvent(id: number, event: ControlEvent): string {
  const dataLines = JSON.stringify(event)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `id: ${id}\n${dataLines}\n\n`;
}

/** Write a chunk to a subscriber, guarding a response already ended/closed. */
function writeChunk(res: ServerResponse, chunk: string): void {
  if (!res.writableEnded) {
    res.write(chunk);
  }
}

/**
 * Relay one control event to every subscribed UI client over SSE. Assigns the
 * next monotonic `Last-Event-ID` and retains the event in the bounded replay
 * buffer FIRST — regardless of whether anyone is currently subscribed — so a
 * client that reconnects afterwards can still reconcile the gap.
 */
export function broadcastEvent(state: EventStreamState, event: ControlEvent): void {
  const id = state.nextEventId++;
  const chunk = encodeSseEvent(id, event);
  state.buffer.push({ id, chunk });
  if (state.buffer.length > EVENT_REPLAY_BUFFER_SIZE) {
    state.buffer.shift();
  }
  for (const res of state.subscribers) {
    writeChunk(res, chunk);
  }
}

/**
 * Parse the reconnect cursor from the `Last-Event-ID` request header, or `null`
 * when it is absent, empty, or not an integer. EventSource sends this header
 * automatically on reconnect, carrying the last `id:` it received.
 */
function parseLastEventId(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[header.length - 1] : header;
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Handle `GET /api/events` — subscribe the browser's `EventSource` to the SSE
 * event stream. On a reconnect carrying `Last-Event-ID`, replays the retained
 * events after that cursor before going live; a fresh connection starts live.
 * Non-GET methods fail closed with a 405.
 */
export function handleEventStream(req: IncomingMessage, res: ServerResponse, state: EventStreamState): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${EVENTS_PATH}`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Open the stream with an SSE comment so headers flush immediately and the
  // client's `open` settles before the first event (a comment is ignored by
  // EventSource). This runs synchronously with the subscribe below — Node is
  // single-threaded, so no `broadcast` can interleave and be missed.
  res.write(": ccctl event stream\n\n");

  // Reconnect reconciliation: replay everything retained after the client's
  // cursor, then fall through to live delivery. A fresh connection (no cursor)
  // is not flooded with the backlog.
  const lastEventId = parseLastEventId(req.headers["last-event-id"]);
  if (lastEventId !== null) {
    for (const buffered of state.buffer) {
      if (buffered.id > lastEventId) {
        writeChunk(res, buffered.chunk);
      }
    }
  }

  state.subscribers.add(res);
  // Reap the subscriber when the browser disconnects, so a closed EventSource
  // never lingers as a dead write target.
  res.on("close", () => {
    state.subscribers.delete(res);
  });
}

/**
 * End every open SSE stream and clear the subscriber set. Called from server
 * shutdown: an SSE response holds its connection open indefinitely, so
 * `httpServer.close()` would otherwise hang waiting on it.
 */
export function closeEventStreams(state: EventStreamState): void {
  for (const res of state.subscribers) {
    res.end();
  }
  state.subscribers.clear();
}
