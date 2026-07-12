// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The per-session worker channel — bridge-protocol §4/§5, the server side, over
 * **HTTP + Server-Sent Events** (issue #130).
 *
 * The current Claude Code `--sdk-url` worker does NOT open a WebSocket: it opens a
 * held-open SSE stream for the server→worker downstream and POSTs its own upstream
 * legs. This module terminates that channel, rooted at
 * `{@link workerChannelPath}` (`/v1/code/sessions/{id}/worker`):
 *
 *   - `POST …/worker/register` `{}` → `{ worker_epoch }` ({@link handleWorkerRegister}).
 *     The server stamps a monotonic per-session epoch; a later register supersedes it,
 *     and an upstream POST carrying a superseded epoch fails closed `409` (the worker
 *     then exits).
 *   - `GET …/worker/events/stream` → a held-open `text/event-stream` downstream
 *     ({@link handleWorkerEventsStream}); the server pushes `client_event` frames down
 *     it (turn injection / steer relay).
 *   - `POST …/worker/events` `{ worker_epoch, events: [{ payload }] }` → the upstream
 *     transcript leg ({@link handleWorkerEvents}); each payload is relayed to the UI
 *     SSE (#13, {@link broadcastEvent}) — this is where a turn's output returns.
 *   - `PUT …/worker` `{ worker_status, worker_epoch, external_metadata }` → the status
 *     gate ({@link handleWorkerStatus}); `idle` means "ready for a turn". It MUST `200`
 *     or the worker exits. The server derives the session's `activity` from it
 *     ({@link applyWorkerStatus}).
 *   - `POST …/worker/heartbeat` → liveness ({@link handleWorkerHeartbeat},
 *     {@link recordHeartbeat}); `POST …/worker/events/delivery`
 *     `{ worker_epoch, updates: [{ event_id, status }] }` → the worker's per-event
 *     downstream acks ({@link handleWorkerDelivery}).
 *
 * **Turn injection** ({@link injectUserTurn}) pushes a `client_event` frame down the
 * held-open downstream. The event name is `client_event`; the `data` is
 * `{ sequence_num, event_id, event_type: "message", payload }`, and `payload.type`
 * is what the worker demuxes on (`user` | `control_request` | `control_response`). A
 * user turn carries a `{ type: "user", message, … }` payload; a UI steer
 * ({@link dispatchControlRequest}) carries the `control_request`. Downstream frames
 * carry no `worker_epoch`; a re-sent `uuid` is de-duplicated by the worker.
 *
 * **Two-credential boundary (HARD, #130).** No account Bearer rides this channel —
 * it is authorized (in the credentialed wave) by the per-session
 * {@link SessionIngressToken} the server minted into the work-secret, NEVER the
 * account Bearer. This slice is loopback-hermetic and does not yet enforce the
 * ingress token on the channel; the token boundary lives in the work-secret mint
 * (`environments-bridge.ts`).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyWorkerStatus,
  BRIDGE_PROTOCOL_API_VERSION,
  isWorkerStatus,
  recordHeartbeat,
  type ControlRequest,
  type JsonValue,
  type Session,
} from "@ccctl/core";
import { broadcastEvent, type SessionEventRelays } from "./event-stream.js";
import { readJsonBody, writeError, writeJson } from "./http-response.js";

/** Hard ceiling on a worker-channel request body (1 MiB) — a control-plane batch fits within it. */
const MAX_WORKER_BODY_BYTES = 1024 * 1024;

/**
 * The live per-session worker channel: its current epoch, its held-open downstream
 * SSE (or `null` when the worker has not opened / has dropped the stream), and the
 * next downstream `client_event` sequence number.
 */
export interface WorkerChannelRecord {
  /** The current `worker_epoch`; a superseded (older) epoch on an upstream POST fails closed 409. */
  epoch: number;
  /** The held-open `worker/events/stream` response the server pushes `client_event` frames to. */
  downstream: ServerResponse | null;
  /** The next `sequence_num` / SSE `id` a pushed downstream frame carries (monotonic, starts at 1). */
  nextSeq: number;
}

/** The per-server state the worker channel reads and updates. */
export interface WorkerChannelState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: Map<string, Session>;
  /** The live per-session worker channel, keyed by session id (epoch + downstream + seq). */
  readonly workerChannels: Map<string, WorkerChannelRecord>;
  /**
   * The per-session UI Server-Sent Events relays. Every payload read off a session's
   * upstream `worker/events` leg (§5) is fanned out to the UI clients subscribed to THAT
   * SESSION's stream (#13/#20), so the upstream read path is also the source of the
   * browser's per-session stream — and a session's output never reaches another
   * session's subscribers.
   */
  readonly eventRelays: SessionEventRelays;
}

/** A matched §4/§5 worker-channel leg plus the session it addresses. */
export type WorkerRoute =
  | { readonly leg: "register"; readonly sessionId: string }
  | { readonly leg: "events-stream"; readonly sessionId: string }
  | { readonly leg: "events"; readonly sessionId: string }
  | { readonly leg: "events-delivery"; readonly sessionId: string }
  | { readonly leg: "heartbeat"; readonly sessionId: string }
  | { readonly leg: "status"; readonly sessionId: string };

/**
 * Match a path against the §4/§5 worker-channel legs — `…/worker` (PUT status),
 * `…/worker/register`, `…/worker/events/stream`, `…/worker/events`,
 * `…/worker/events/delivery`, `…/worker/heartbeat` — extracting the session id, or
 * `null` when it is not a worker-channel path. Anchored on the pinned
 * {@link BRIDGE_PROTOCOL_API_VERSION} (`/v1/code/sessions/{id}/worker/…`), so a
 * version-drifted path fails to match and 404s rather than being served. The session
 * id is a server-minted UUID (no embedded `/`), so segment splitting is exact.
 */
export function matchWorkerRoute(pathname: string): WorkerRoute | null {
  const segments = pathname.split("/");
  // Expect ["", "v1", "code", "sessions", {id}, "worker", …tail].
  if (
    segments.length < 6 ||
    segments[0] !== "" ||
    segments[1] !== BRIDGE_PROTOCOL_API_VERSION ||
    segments[2] !== "code" ||
    segments[3] !== "sessions" ||
    segments[5] !== "worker"
  ) {
    return null;
  }
  const sessionId = segments[4];
  if (sessionId === undefined || sessionId === "") {
    return null;
  }
  const tail = segments.slice(6);
  if (tail.length === 0) {
    return { leg: "status", sessionId };
  }
  if (tail.length === 1 && tail[0] === "register") {
    return { leg: "register", sessionId };
  }
  if (tail.length === 1 && tail[0] === "events") {
    return { leg: "events", sessionId };
  }
  if (tail.length === 1 && tail[0] === "heartbeat") {
    return { leg: "heartbeat", sessionId };
  }
  if (tail.length === 2 && tail[0] === "events" && tail[1] === "stream") {
    return { leg: "events-stream", sessionId };
  }
  if (tail.length === 2 && tail[0] === "events" && tail[1] === "delivery") {
    return { leg: "events-delivery", sessionId };
  }
  return null;
}

/**
 * `POST …/worker/register` (§4). Mints and returns a fresh per-session
 * `worker_epoch` — monotonic, so a re-register SUPERSEDES the prior epoch and any
 * upstream POST still stamped with it fails closed 409. Ends a stale held-open
 * downstream from the superseded epoch. The `{}` body is not load-bearing (drained,
 * ignored). Fails closed 404 for an unknown session.
 */
export function handleWorkerRegister(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-register path`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  req.resume(); // drain the ignorable `{}` body so the socket does not stall.
  const prev = state.workerChannels.get(sessionId);
  // A re-register supersedes the prior epoch: end the stale downstream so the old
  // worker's held stream is not left dangling, and bump the epoch.
  if (prev?.downstream !== null && prev?.downstream !== undefined) {
    prev.downstream.end();
  }
  const epoch = (prev?.epoch ?? 0) + 1;
  state.workerChannels.set(sessionId, { epoch, downstream: null, nextSeq: prev?.nextSeq ?? 1 });
  writeJson(res, 200, { worker_epoch: epoch });
}

/**
 * `GET …/worker/events/stream` (§4). Holds the response open as the server→worker
 * downstream `text/event-stream`; the server pushes `client_event` frames down it
 * (turn injection / steer). Requires the worker to have registered (the epoch the
 * channel is bound to) — an unregistered session fails closed 409. Reaped when the
 * worker disconnects. Fails closed 404/405 for an unknown session / wrong method.
 */
export function handleWorkerEventsStream(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-events-stream path`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  const record = state.workerChannels.get(sessionId);
  if (record === undefined) {
    writeError(res, 409, `ccctl: session ${sessionId} worker must register before opening the events stream`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Open with an SSE comment so headers flush immediately and the worker's stream
  // settles before the first pushed frame (a comment is ignored by an SSE reader).
  res.write(": ccctl worker stream\n\n");
  record.downstream = res;
  // Reap the downstream when the worker disconnects, so a closed stream is never a
  // dangling write target — but only if it still points at THIS response, so a late
  // close of a superseded stream cannot evict a reconnect's live downstream.
  res.on("close", () => {
    if (record.downstream === res) {
      record.downstream = null;
    }
  });
}

/**
 * `POST …/worker/events` (§5). The upstream transcript leg: a batched
 * `{ worker_epoch, events: [{ payload }] }`. Each payload is a raw `stream-json`
 * message the server relays to the UI SSE (#13) — this is where a turn's output
 * returns. Fails closed 404 (unknown session), 409 (superseded epoch), or 400
 * (malformed body). MUST `200` on success.
 */
export function handleWorkerEvents(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "POST", (_record, body) => {
    const events = body.events;
    if (!Array.isArray(events)) {
      writeError(res, 400, "ccctl: worker-events body `events` must be an array");
      return;
    }
    for (const entry of events) {
      // Relay each event's payload verbatim to THIS SESSION's UI stream (#20: never to
      // another session's subscribers). A malformed entry (no `payload`) is skipped rather
      // than tearing down the batch — fail-soft per event, fail-closed only on the batch
      // envelope above.
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && "payload" in entry) {
        broadcastEvent(state.eventRelays, sessionId, (entry as { payload: JsonValue }).payload);
      }
    }
    writeJson(res, 200, {});
  });
}

/**
 * `PUT …/worker` (§4). The status gate: `{ worker_status, worker_epoch,
 * external_metadata }`. Derives the session's `activity` from `worker_status`
 * ({@link applyWorkerStatus}) — `idle` means "ready for a turn". Fails closed 404
 * (unknown session), 409 (superseded epoch), or 400 (unknown `worker_status`,
 * drift). MUST `200` on success or the worker exits.
 */
export function handleWorkerStatus(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "PUT", (_record, body) => {
    const workerStatus = body.worker_status;
    if (!isWorkerStatus(workerStatus)) {
      writeError(res, 400, "ccctl: worker-status body carries an unknown `worker_status` (drift)");
      return;
    }
    const session = state.sessions.get(sessionId);
    if (session !== undefined) {
      state.sessions.set(sessionId, applyWorkerStatus(session, workerStatus));
    }
    writeJson(res, 200, {});
  });
}

/**
 * `POST …/worker/heartbeat` (§4). Liveness: refreshes the session's
 * `lastActivityAt` ({@link recordHeartbeat}). The body is not load-bearing (drained,
 * ignored) — liveness must stay robust, so it is not epoch-gated. Fails closed
 * 404/405 for an unknown session / wrong method. MUST `200`.
 */
export function handleWorkerHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-heartbeat path`);
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  req.resume(); // drain the (ignorable) body.
  state.sessions.set(sessionId, recordHeartbeat(session));
  writeJson(res, 200, {});
}

/**
 * `POST …/worker/events/delivery` (§5). The worker's per-event downstream acks:
 * `{ worker_epoch, updates: [{ event_id, status }] }`. Accepted (this slice has no
 * redelivery / visibility-timeout, so the acks are a no-op beyond validation). Fails
 * closed 404 (unknown session), 409 (superseded epoch), or 400 (malformed body).
 * MUST `200`.
 */
export function handleWorkerDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "POST", (_record, body) => {
    if (!Array.isArray(body.updates)) {
      writeError(res, 400, "ccctl: worker-delivery body `updates` must be an array");
      return;
    }
    writeJson(res, 200, {});
  });
}

/**
 * Inject one user turn — push a `{ type: "user" }` `client_event` down the session's
 * held-open downstream (§4/§5 turn injection). The `--sdk-url` worker demuxes on
 * `payload.type`, so a user prompt is a `user` message. Fails closed (throws) when
 * the session has no live downstream — the UI-facing caller ({@link injectTurn})
 * surfaces that.
 */
export function injectUserTurn(state: WorkerChannelState, sessionId: string, prompt: string): void {
  const payload: JsonValue = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
  pushClientEvent(state, sessionId, payload);
}

/**
 * Relay one UI steer worker-ward — push the {@link ControlRequest} as the payload of
 * a `client_event` down the session's held-open downstream. `request.type` is
 * `"control_request"`, one of the demux types the worker reads. Fails closed
 * (throws) when the session has no live downstream, the same as {@link injectUserTurn}.
 */
export function dispatchControlRequest(state: WorkerChannelState, sessionId: string, request: ControlRequest): void {
  pushClientEvent(state, sessionId, request as unknown as JsonValue);
}

/**
 * Whether the session has a LIVE worker channel — a worker that registered AND is
 * holding its §4/§5 downstream open. This is exactly {@link injectUserTurn}'s
 * precondition: `true` iff a `client_event` push would NOT fail closed (`record`
 * present with a non-null `downstream`). The receiver-grounded read of "a real worker
 * is connected", distinct from the session merely existing; `false` for an unknown
 * session or one whose worker has not opened (or has closed) its downstream.
 */
export function hasLiveWorkerChannel(state: WorkerChannelState, sessionId: string): boolean {
  const record = state.workerChannels.get(sessionId);
  return record !== undefined && record.downstream !== null;
}

/**
 * End every held-open worker downstream and clear it — called from server shutdown.
 * A held-open SSE response keeps its connection open indefinitely, so
 * `httpServer.close()` would otherwise hang waiting on it (the UI-stream analog in
 * `event-stream.ts`).
 */
export function closeWorkerChannels(state: WorkerChannelState): void {
  for (const record of state.workerChannels.values()) {
    if (record.downstream !== null) {
      record.downstream.end();
      record.downstream = null;
    }
  }
}

// --- internals ---

/** One downstream `client_event` frame per §4/§5: event name pinned, `data` the demux envelope. */
function pushClientEvent(state: WorkerChannelState, sessionId: string, payload: JsonValue): void {
  const record = state.workerChannels.get(sessionId);
  if (record === undefined || record.downstream === null) {
    throw new Error(`ccctl: no live worker channel for session ${sessionId}`);
  }
  const seq = record.nextSeq++;
  const data = JSON.stringify({ sequence_num: seq, event_id: randomUUID(), event_type: "message", payload });
  record.downstream.write(`event: client_event\nid: ${seq}\ndata: ${data}\n\n`);
}

/**
 * Read + epoch-validate an upstream worker POST body, then invoke `onBody` with the
 * live {@link WorkerChannelRecord} and the parsed object. Centralizes the shared
 * fail-closed tail of the `events` / `status` / `delivery` legs: wrong method → 405,
 * unknown session → 404, unregistered / superseded epoch → 409, non-object or
 * over-cap body → 400/413. Only a request that clears all of these reaches `onBody`.
 */
function readWorkerBody(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
  method: "POST" | "PUT",
  onBody: (record: WorkerChannelRecord, body: Record<string, unknown>) => void,
): void {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker channel`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  void readJsonBody(req, MAX_WORKER_BODY_BYTES).then((result) => {
    if (!result.ok) {
      writeError(res, result.status, result.message);
      return;
    }
    if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
      writeError(res, 400, "ccctl: worker channel body must be a JSON object");
      return;
    }
    const body = result.value as Record<string, unknown>;
    const record = state.workerChannels.get(sessionId);
    // The epoch gate: the worker must have registered, and the stamped epoch must be
    // the current one. A superseded (or absent) epoch fails closed 409 — the worker exits.
    if (record === undefined || body.worker_epoch !== record.epoch) {
      writeError(res, 409, `ccctl: worker channel epoch superseded for session ${sessionId}`);
      return;
    }
    onBody(record, body);
  });
}
