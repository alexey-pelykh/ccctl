// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The UI event stream — the per-session Server-Sent Events (SSE) relay to the browser
 * (#13, partitioned per session by #20).
 *
 * This is the downstream half of the zero-build UI transport pair: the worker channel
 * (`worker-channel.ts`) fans every payload it reads off a session's upstream
 * `POST …/worker/events` leg (§5) out to the UI clients subscribed to THAT SESSION here,
 * and the browser's `EventSource` reads them off `GET /api/sessions/{id}/events`. The
 * upstream half — the browser's `fetch` POST that steers a session — is `ui-command.ts`.
 *
 * The relayed payload is a RAW worker event ({@link JsonValue}) — a `stream-json`
 * message off the `--sdk-url` control transport, not necessarily a `control_event`.
 * The browser's decoder classifies a `control_event` (transcript / current-turn) and
 * surfaces anything else verbatim, so relaying the raw payload here is faithful (no
 * shape is dropped) rather than filtered.
 *
 * What this slice guarantees:
 *   1. Every relayed event carries a monotonic **`Last-Event-ID`-compatible id**
 *      (SSE's `id:` field). EventSource replays the last id it saw on reconnect,
 *      so the id is what lets a client reconcile the gap it missed. The id is
 *      PER SESSION — each session's stream has its own monotonic cursor, so a
 *      reconnect resumes exactly that session's backlog.
 *   2. A bounded per-session **replay buffer**: on reconnect the server replays the
 *      retained events AFTER the client's `Last-Event-ID`, then goes live. A fresh
 *      connection (no cursor) is NOT replayed the backlog — it starts live.
 *
 * **Per-session partitioning (#20).** Each session id owns its OWN {@link EventStreamState}
 * relay — subscribers, replay buffer, and event-id cursor are independent — held in the
 * {@link SessionEventRelays} registry. A `broadcast` for session A reaches ONLY session A's
 * subscribers; session B's stream never sees it. This IS the "event relay routed to the
 * correct session, never cross-wired" contract: cross-wiring is structurally impossible
 * because the session id selects the relay before a single byte is written. A relay is
 * created lazily (first subscribe OR first broadcast for that session), so a worker event
 * that arrives before any UI subscriber is still retained for a later reconnect.
 *
 * Browser-facing auth is deferred: the loopback UI ingress is unauthenticated at this
 * slice (the account Bearer is the WORKER's credential, riding §1/§2 — register +
 * session-create — ONLY; the per-session ingress token authorizes the §4/§5 worker
 * channel, never the browser). The local-server credential boundary — how the UI/tunnel
 * authenticates — is the deferred security item.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue, Session } from "@ccctl/core";
import { writeError } from "./http-response.js";

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

/** The per-SESSION SSE relay state: live subscribers plus the replay buffer. */
export interface EventStreamState {
  /** The open SSE responses (one per connected UI client viewing this session). */
  readonly subscribers: Set<ServerResponse>;
  /** Recent events retained for `Last-Event-ID` reconnect replay (bounded). */
  readonly buffer: BufferedEvent[];
  /** The id the next relayed event will carry (monotonic, starts at 1). */
  nextEventId: number;
}

/**
 * The per-server registry of per-session SSE relays, keyed by session id. A session's
 * relay is created lazily (see {@link relayFor}); the registry never cross-wires two
 * sessions because a broadcast / subscribe selects the relay by id first.
 */
export type SessionEventRelays = Map<string, EventStreamState>;

/**
 * The per-server state the UI SSE relay reads: the session registry (to validate a
 * subscribe targets a real session) and the per-session relays. A structural subset of
 * the overall {@link CcctlServer} state, so this module stays decoupled from the HTTP
 * wiring in `index.ts`.
 */
export interface UiEventStreamState {
  /** Sessions tracked by the server, keyed by ccctl session id (a subscribe 404s an unknown one). */
  readonly sessions: ReadonlyMap<string, Session>;
  /** The per-session SSE relays. */
  readonly eventRelays: SessionEventRelays;
}

/** A fresh, empty per-session relay. */
export function createEventStreamState(): EventStreamState {
  return { subscribers: new Set<ServerResponse>(), buffer: [], nextEventId: 1 };
}

/** A fresh, empty per-session relay registry — one per server. */
export function createSessionEventRelays(): SessionEventRelays {
  return new Map<string, EventStreamState>();
}

/**
 * Get-or-create a session's relay. The single lazy-create seam shared by both the
 * subscribe path ({@link handleEventStream}) and the broadcast path
 * ({@link broadcastEvent}), so both see the SAME relay instance for a session and a
 * worker event that predates any subscriber is still buffered for a later reconnect.
 */
export function relayFor(relays: SessionEventRelays, sessionId: string): EventStreamState {
  let relay = relays.get(sessionId);
  if (relay === undefined) {
    relay = createEventStreamState();
    relays.set(sessionId, relay);
  }
  return relay;
}

/**
 * Encode one worker event payload as an SSE message carrying its `Last-Event-ID`
 * `id`. `JSON.stringify` never emits a literal newline (a newline inside a string is
 * escaped as `\n`), so the payload is a single physical line; the split still
 * defends the framing, since an SSE `data` field spanning newlines must repeat
 * the `data:` prefix per line.
 */
function encodeSseEvent(id: number, payload: JsonValue): string {
  const dataLines = JSON.stringify(payload)
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
 * Relay one worker event payload to every UI client subscribed to `sessionId`'s stream
 * over SSE — and ONLY that session's subscribers (#20: never cross-wired). Assigns the
 * next monotonic per-session `Last-Event-ID` and retains the event in that session's
 * bounded replay buffer FIRST — regardless of whether anyone is currently subscribed —
 * so a client that reconnects afterwards can still reconcile the gap. Lazily materializes
 * the session's relay, so a worker event that arrives before any UI subscriber is buffered.
 */
export function broadcastEvent(relays: SessionEventRelays, sessionId: string, payload: JsonValue): void {
  const state = relayFor(relays, sessionId);
  const id = state.nextEventId++;
  const chunk = encodeSseEvent(id, payload);
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
 * Handle `GET /api/sessions/{id}/events` — subscribe the browser's `EventSource` to
 * `sessionId`'s SSE stream. Fails closed `404` for an unknown session (never opening a
 * stream onto a session that does not exist) and `405` for a non-GET method. On a
 * reconnect carrying `Last-Event-ID`, replays that session's retained events after the
 * cursor before going live; a fresh connection starts live.
 */
export function handleEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  state: UiEventStreamState,
  sessionId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the session events path`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  const relay = relayFor(state.eventRelays, sessionId);

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

  // Reconnect reconciliation: replay everything this session retained after the
  // client's cursor, then fall through to live delivery. A fresh connection (no
  // cursor) is not flooded with the backlog.
  const lastEventId = parseLastEventId(req.headers["last-event-id"]);
  if (lastEventId !== null) {
    for (const buffered of relay.buffer) {
      if (buffered.id > lastEventId) {
        writeChunk(res, buffered.chunk);
      }
    }
  }

  relay.subscribers.add(res);
  // Reap the subscriber when the browser disconnects, so a closed EventSource
  // never lingers as a dead write target.
  res.on("close", () => {
    relay.subscribers.delete(res);
  });
}

/**
 * End every open SSE stream across every session and clear each subscriber set. Called
 * from server shutdown: an SSE response holds its connection open indefinitely, so
 * `httpServer.close()` would otherwise hang waiting on it.
 */
export function closeEventStreams(relays: SessionEventRelays): void {
  for (const relay of relays.values()) {
    for (const res of relay.subscribers) {
      res.end();
    }
    relay.subscribers.clear();
  }
}

/**
 * Close and REMOVE a single session's relay — the per-session counterpart of
 * {@link closeEventStreams}, called when a session is evicted from the registry (#176).
 * Ends every open subscriber stream (so no UI client is left reading a stream onto a
 * session that no longer exists), clears the subscriber set, then drops the session's
 * entry from the registry so an evicted session's relay does not accumulate for the
 * daemon's lifetime. A **no-op** when the session has no relay — one is created lazily
 * (first subscribe or first broadcast, {@link relayFor}), so a session never broadcast-to
 * or subscribed-to has nothing to reap.
 */
export function closeSessionRelay(relays: SessionEventRelays, sessionId: string): void {
  const relay = relays.get(sessionId);
  if (relay === undefined) {
    return;
  }
  for (const res of relay.subscribers) {
    res.end();
  }
  relay.subscribers.clear();
  relays.delete(sessionId);
}
