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
 *     ({@link applyWorkerStatus}). `GET …/worker` on the SAME bare path is the child's
 *     worker-state restore ({@link handleWorkerStateRestore}) — an empty `200` (issue
 *     #154); the path is method-multiplexed (GET restore / PUT status).
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
  isSessionStale,
  isWorkerStatus,
  markSessionClosed,
  markSessionReady,
  recordHeartbeat,
  type ControlRequest,
  type JsonValue,
  type Session,
} from "@ccctl/core";
import { broadcastEvent, closeSessionRelay, type SessionEventRelays } from "./event-stream.js";
import { readJsonBody, writeError, writeJson } from "./http-response.js";

/** Hard ceiling on a worker-channel request body (1 MiB) — a control-plane batch fits within it. */
const MAX_WORKER_BODY_BYTES = 1024 * 1024;

/**
 * Default interval (ms) between the per-session downstream **liveness frames** (#166).
 *
 * The `--sdk-url` worker's SSE reader enforces a ~45s liveness timeout on its held-open
 * downstream and counts ONLY real `client_event` frames toward it — a comment-only
 * keepalive (`:` line) does NOT reset it. So an idle session, whose downstream is otherwise
 * silent after the opening comment, is guaranteed to hit the timeout and flap
 * (connect → timeout → reconnect). Emitting a no-op `client_event` every
 * {@link DEFAULT_WORKER_LIVENESS_INTERVAL_MS} holds the stream open indefinitely.
 *
 * 20s sits comfortably below the ~45s window with margin for jitter: even a delayed second
 * frame (at ~40s) still lands before the timeout, whereas a 25–30s interval leaves a delayed
 * frame racing the deadline. Overridable per server ({@link ServerConfig.workerLivenessIntervalMs}).
 */
export const DEFAULT_WORKER_LIVENESS_INTERVAL_MS = 20_000;

/**
 * Default grace window (ms) before a session whose worker downstream has gone null is CLOSED and
 * evicted from the registry (#173).
 *
 * A worker dropping its held-open downstream is NORMAL on a transient reconnect — it re-registers
 * with a fresh downstream after a network blip — so a null downstream ALONE must never evict
 * (reconnect-safety). Eviction is instead **liveness-driven** (issue #173's recommended policy,
 * leaning on the #41 heartbeat): the downstream close only ARMS a check this many ms later, and the
 * check evicts ONLY when the downstream is STILL null AND no heartbeat has landed within the window
 * ({@link isSessionStale}) — i.e. the worker has genuinely gone silent, not merely dropped its
 * stream. A still-beating worker (downstream dropped but heartbeats continuing) is retained.
 *
 * 30s matches {@link DEFAULT_HEARTBEAT_STALE_AFTER_MS}: a session with no downstream and no
 * heartbeat for a full staleness window is presumed terminally gone. Comfortably longer than a
 * worker's reconnect/liveness cycle, so a genuine reconnect re-registers well before the window
 * lapses. Overridable per server ({@link ServerConfig.sessionEvictionGraceMs}); a test passes a
 * short value to exercise eviction deterministically.
 */
export const DEFAULT_SESSION_EVICTION_GRACE_MS = 30_000;

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
  /**
   * The armed per-session **liveness interval** (#166) writing a periodic no-op `client_event`
   * down {@link downstream} to keep it past the worker's ~45s liveness timeout; `null` when no
   * downstream is held. Cleared on stream close, on supersede (a re-register bumps the epoch),
   * and on shutdown — so no frame is ever written to a reaped stream and no interval dangles.
   */
  livenessTimer: ReturnType<typeof setInterval> | null;
  /**
   * The armed grace-delayed **eviction check** (#173), scheduled when the downstream goes null to
   * decide — one grace window later — whether the session is terminally gone (→ closed + evicted)
   * or merely reconnecting (retained); `null` when no check is pending. Cleared on reconnect
   * (re-register / reopen) and on shutdown via {@link endDownstream}, so a pending eviction never
   * fires against a session whose worker came back or a server that is shutting down.
   */
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

/** The per-server state the worker channel reads and updates. */
export interface WorkerChannelState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: Map<string, Session>;
  /** The live per-session worker channel, keyed by session id (epoch + downstream + seq). */
  readonly workerChannels: Map<string, WorkerChannelRecord>;
  /**
   * Interval (ms) between per-session downstream liveness frames (#166). Resolved once at
   * server start ({@link ServerConfig.workerLivenessIntervalMs} ??
   * {@link DEFAULT_WORKER_LIVENESS_INTERVAL_MS}); a test passes a short value to exercise the
   * timer deterministically.
   */
  readonly workerLivenessIntervalMs: number;
  /**
   * Grace window (ms) before a downstream-null session is closed + evicted (#173). Resolved once at
   * server start ({@link ServerConfig.sessionEvictionGraceMs} ??
   * {@link DEFAULT_SESSION_EVICTION_GRACE_MS}); doubles as the staleness window the eviction check
   * measures the heartbeat gap against ({@link isSessionStale}). A test passes a short value to
   * exercise eviction deterministically.
   */
  readonly sessionEvictionGraceMs: number;
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
 * Match a path against the §4/§5 worker-channel legs — `…/worker` (GET restore / PUT status),
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
 * Fail closed on any §4 leg addressed to a session that has not yet registered over the bridge (#33)
 * — answers `409` and returns `true` when the caller must stop.
 *
 * A `registering` session is a UC2 launch whose worker has not checked in yet. It IS in the session
 * map (that is the point — the operator watches it come up), so the "unknown session" `404` does not
 * catch it. But it is not yet ANYBODY'S: its id was minted server-side and handed to the OPERATOR,
 * while a launched worker only ever learns its own id from the §3 work item that §2 enqueues — so §2
 * necessarily precedes §4, and no legitimate §4 caller can be holding this id. The session is also
 * still EVICTABLE, and eviction reaps the session and its relay while knowing nothing about worker
 * channels: anything a §4 leg builds on it (a channel with its held-open downstream and liveness
 * interval; a refreshed heartbeat) would outlive the session that owns it.
 *
 * So the whole §4 surface is closed until §2 has run — not merely `register`, even though `register`
 * is the only leg that can CREATE a channel. A heartbeat answering `200` for a session no worker can
 * legitimately be heartbeating would undercut exactly the argument this guard rests on.
 */
function rejectIfRegistering(res: ServerResponse, session: Session, sessionId: string): boolean {
  if (session.status !== "registering") {
    return false;
  }
  writeError(res, 409, `ccctl: session ${sessionId} has not registered over the bridge yet`);
  return true;
}

/**
 * `POST …/worker/register` (§4). Mints and returns a fresh per-session
 * `worker_epoch` — monotonic, so a re-register SUPERSEDES the prior epoch and any
 * upstream POST still stamped with it fails closed 409. Ends a stale held-open
 * downstream from the superseded epoch. The `{}` body is not load-bearing (drained,
 * ignored). Fails closed 404 for an unknown session, and 409 for a session that has
 * not registered over the bridge yet ({@link rejectIfRegistering}) — this is the only
 * leg that can create a worker channel, so it is the one that must not create one on a
 * session eviction may still reap.
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
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  if (rejectIfRegistering(res, session, sessionId)) {
    return;
  }
  req.resume(); // drain the ignorable `{}` body so the socket does not stall.
  const prev = state.workerChannels.get(sessionId);
  // A re-register supersedes the prior epoch: synchronously end the stale downstream and clear its
  // liveness interval (`endDownstream` — no dangling timer, no frame written to a reaped stream,
  // #166) so the old worker's held stream is not left dangling, then bump the epoch.
  if (prev !== undefined) {
    endDownstream(prev);
  }
  const epoch = (prev?.epoch ?? 0) + 1;
  state.workerChannels.set(sessionId, {
    epoch,
    downstream: null,
    nextSeq: prev?.nextSeq ?? 1,
    livenessTimer: null,
    evictionTimer: null,
  });
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
  // A second open on the SAME record (no intervening re-register) supersedes the prior held
  // stream: end it and clear its still-armed liveness interval (`endDownstream`) before this one
  // takes the slot — otherwise that timer is orphaned (a later `clearLivenessTimer` only ever sees
  // the newest `record.livenessTimer`) and dangles until the first response closes. The normal
  // worker holds exactly ONE downstream per registration, so this only fires on a
  // duplicate/misbehaving open; routing it through `endDownstream` keeps "no dangling timer" total.
  endDownstream(record);
  res.write(": ccctl worker stream\n\n");
  record.downstream = res;
  // The downstream is attached and the session is now steerable, so advance its transport
  // lifecycle `connecting`→`ready` (#172). `markSessionReady` is a no-op on an already-advanced
  // session, and the reverse leg (`→closed`/`errored` on teardown) is a separate transition.
  const session = state.sessions.get(sessionId);
  if (session !== undefined) {
    state.sessions.set(sessionId, markSessionReady(session));
  }
  // Arm the per-session liveness interval (#166): a no-op `client_event` every
  // `workerLivenessIntervalMs` keeps THIS held-open downstream past the worker's ~45s
  // liveness timeout — a silent idle downstream would otherwise be reaped by the worker and
  // flap. `.unref()` so a lingering interval alone never blocks process exit; it is also
  // cleared on close (below), on supersede (`handleWorkerRegister`), and on shutdown
  // (`closeWorkerChannels`).
  const timer = setInterval(() => {
    writeLivenessFrame(record, res);
  }, state.workerLivenessIntervalMs);
  timer.unref();
  record.livenessTimer = timer;
  // Reap the downstream when the worker disconnects, so a closed stream is never a
  // dangling write target — but only if it still points at THIS response, so a late
  // close of a superseded stream cannot evict a reconnect's live downstream. Clearing THIS
  // response's interval is unconditional (it belongs to this stream regardless).
  res.on("close", () => {
    clearInterval(timer);
    if (record.downstream === res) {
      record.downstream = null;
      record.livenessTimer = null;
      // The worker dropped its LIVE downstream. That is NORMAL on a transient reconnect (it
      // re-registers / reopens with a fresh downstream after a network blip), so a null downstream
      // alone must NOT evict (#173 reconnect-safety). Arm a grace-delayed liveness check that
      // evicts ONLY a terminally-gone session — downstream still null AND heartbeat lapsed (#41
      // staleness) — and RETAINS a still-beating one. Cleared on reconnect / shutdown via
      // `endDownstream`, and neutralized by an identity guard if the record was superseded.
      scheduleEviction(state, sessionId, record);
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
 * `GET …/worker` (§4 worker-state restore, issue #154). The bare `…/worker` path is
 * method-multiplexed: `PUT` is the status gate ({@link handleWorkerStatus}); `GET` —
 * the child's worker-state restore — previously 405'd (the path was PUT-only) and the
 * child retried in a loop. It answers an empty `200`: `{ worker: null }` when the
 * server holds no restorable worker state (its steady state at this slice —
 * `external_metadata` / `internal_metadata` are read off the `PUT` status body but not
 * persisted, so there is nothing to restore), or, once such state IS tracked,
 * `{ worker: { external_metadata, internal_metadata } }`. Fails closed `404` for an
 * unknown session, `409` for one that has not registered over the bridge yet
 * ({@link rejectIfRegistering}), `405` for a non-GET (defensive — the router sends GET here).
 */
export function handleWorkerStateRestore(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-state-restore path`);
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  if (rejectIfRegistering(res, session, sessionId)) {
    return;
  }
  // No restorable worker state is persisted at this slice, so this is always the empty
  // `{ worker: null }` form — the "nothing to restore" envelope the worker tolerates.
  writeJson(res, 200, { worker: null });
}

/**
 * `POST …/worker/heartbeat` (§4). Liveness: refreshes the session's
 * `lastActivityAt` ({@link recordHeartbeat}). The body is not load-bearing (drained,
 * ignored) — liveness must stay robust, so it is not epoch-gated. Fails closed
 * 404/405 for an unknown session / wrong method, and 409 for one that has not registered
 * over the bridge yet ({@link rejectIfRegistering}) — a `registering` session has no worker
 * that could legitimately be heartbeating it. MUST `200` otherwise.
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
  if (rejectIfRegistering(res, session, sessionId)) {
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
    endDownstream(record);
    record.downstream = null;
  }
}

// --- internals ---

/**
 * The inert payload of a **liveness frame** (#166) — a well-formed `client_event` the worker
 * counts toward downstream liveness (it is the SSE event NAME, `client_event`, that resets the
 * worker's ~45s timeout) yet demuxes to nothing: `type` is NOT one of the worker's demux
 * discriminants (`user` / `control_request` / `control_response`), so no turn is injected and no
 * control action runs. Being a DOWNSTREAM push it also never rides the upstream `worker/events`
 * transcript leg, so nothing is surfaced to the UI and `worker_status` is untouched — the frame
 * is a no-op beyond keeping the stream alive.
 *
 * The namespaced `type` avoids collision with any real worker payload. Worker-side inertness is
 * proven end-to-end against a real worker by the #167 e2e follow-up; here it is a no-op by
 * construction on the server side (asserted in worker-channel.test.ts).
 */
const LIVENESS_PAYLOAD: JsonValue = { type: "ccctl_liveness" };

/**
 * Write one `client_event` frame down a record's live downstream per §4/§5 — event name pinned,
 * `data` the demux envelope — consuming a monotonic `sequence_num` so the worker sees a gap-free
 * stream. A `null` downstream is a silent no-op; each caller gates that per its own contract
 * ({@link pushClientEvent} throws first; {@link writeLivenessFrame} guards first).
 */
function writeClientEventFrame(record: WorkerChannelRecord, payload: JsonValue): void {
  const { downstream } = record;
  if (downstream === null) {
    return;
  }
  const seq = record.nextSeq++;
  const data = JSON.stringify({ sequence_num: seq, event_id: randomUUID(), event_type: "message", payload });
  downstream.write(`event: client_event\nid: ${seq}\ndata: ${data}\n\n`);
}

/**
 * Push one `client_event` down the session's held-open downstream (turn injection / steer). Fails
 * closed (throws) when the session has no live downstream — the UI-facing callers surface that.
 */
function pushClientEvent(state: WorkerChannelState, sessionId: string, payload: JsonValue): void {
  const record = state.workerChannels.get(sessionId);
  if (record === undefined || record.downstream === null) {
    throw new Error(`ccctl: no live worker channel for session ${sessionId}`);
  }
  writeClientEventFrame(record, payload);
}

/**
 * Write one no-op {@link LIVENESS_PAYLOAD} `client_event` (#166) — but ONLY if `res` is still the
 * record's live, writable downstream. Guards (never throws) so a fired-but-stale interval can
 * never write to a reaped/ended stream; unlike {@link pushClientEvent} an absent/mismatched
 * downstream is a silent no-op, not an error.
 */
function writeLivenessFrame(record: WorkerChannelRecord, res: ServerResponse): void {
  if (record.downstream !== res || res.writableEnded) {
    return;
  }
  writeClientEventFrame(record, LIVENESS_PAYLOAD);
}

/**
 * Clear a record's armed liveness interval, if any, and null the field. Idempotent — safe on a
 * record whose timer is already null or already cleared (supersede + a later stream-close both
 * reach it).
 */
function clearLivenessTimer(record: WorkerChannelRecord): void {
  if (record.livenessTimer !== null) {
    clearInterval(record.livenessTimer);
    record.livenessTimer = null;
  }
}

/**
 * Clear a record's armed grace-delayed eviction check (#173), if any, and null the field.
 * Idempotent — safe on a record with no pending eviction. Routed through {@link endDownstream} so a
 * reconnect (re-register / reopen) or shutdown cancels a pending eviction the SAME way it tears the
 * downstream down — a returning worker's session is never evicted out from under it.
 */
function clearEvictionTimer(record: WorkerChannelRecord): void {
  if (record.evictionTimer !== null) {
    clearTimeout(record.evictionTimer);
    record.evictionTimer = null;
  }
}

/**
 * End a record's held-open downstream and clear its armed timers — the liveness interval (#166) AND
 * any pending eviction check (#173) — the single teardown every downstream-ending path routes
 * through: a supersede (a re-register in {@link handleWorkerRegister}, a duplicate open in
 * {@link handleWorkerEventsStream}) and shutdown ({@link closeWorkerChannels}). Ending the stream
 * and clearing its timers are kept inseparable here so no new downstream inherits a stale interval,
 * no timer is left to dangle, and a reconnect cancels a pending eviction. Leaves `record.downstream`
 * set for the caller to null or reassign.
 */
function endDownstream(record: WorkerChannelRecord): void {
  clearLivenessTimer(record);
  clearEvictionTimer(record);
  if (record.downstream !== null) {
    record.downstream.end();
  }
}

/**
 * Arm the grace-delayed eviction check (#173) for a record whose downstream just went null. The
 * one-shot fires after {@link WorkerChannelState.sessionEvictionGraceMs}; `.unref()` so a pending
 * check alone never blocks process exit. Stored on {@link WorkerChannelRecord.evictionTimer} so a
 * reconnect / reopen / shutdown clears it through {@link endDownstream}. Re-armed by
 * {@link considerEviction} while a beating-but-downstream-less worker keeps the session alive.
 */
function scheduleEviction(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  const timer = setTimeout(() => {
    considerEviction(state, sessionId, record);
  }, state.sessionEvictionGraceMs);
  timer.unref();
  record.evictionTimer = timer;
}

/**
 * The grace-delayed eviction DECISION (#173): CLOSE + evict a terminally-gone session, RETAIN a
 * transiently-reconnecting or still-beating one. Fires one grace window after the downstream went
 * null ({@link scheduleEviction}). Evicts ONLY when ALL of the following hold — otherwise it
 * retains (re-arming when the worker is merely beating without a downstream, so a later silence is
 * still caught):
 *   - the record is still the session's CURRENT channel — a re-register swapped in a fresh record,
 *     so this stale closure bails and lets the new registration own the session's lifecycle;
 *   - the downstream is still null — a reopened downstream means the worker is back → retain;
 *   - the session still exists — a prior pass already evicted it → nothing to do;
 *   - the session is STALE — no heartbeat within the grace window ({@link isSessionStale}). A fresh
 *     heartbeat means the worker is alive though its downstream dropped, so a null downstream ALONE
 *     never evicts (the reconnect-safety AC).
 * On eviction it drives the session to its terminal `closed` state ({@link markSessionClosed}, the
 * reverse leg of #172's `connecting`→`ready`) and deletes BOTH the session and its worker channel,
 * so `GET /api/sessions` ("`ccctl attach`") stops listing it and the registry does not grow
 * unbounded across worker exits.
 */
function considerEviction(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  record.evictionTimer = null; // this one-shot has fired.
  // A re-register replaced the record: this closure is stale — the fresh registration owns the
  // session now, so never let it evict a reconnected session.
  if (state.workerChannels.get(sessionId) !== record) {
    return;
  }
  // The worker reopened its downstream — it is back. Retain.
  if (record.downstream !== null) {
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return;
  }
  // Downstream still null but the worker is still heart-beating — alive, just without a downstream.
  // A null downstream alone must NOT evict (#173): retain, and re-check after another grace window
  // so a subsequent silence is still caught.
  if (!isSessionStale(session, Date.now(), state.sessionEvictionGraceMs)) {
    scheduleEviction(state, sessionId, record);
    return;
  }
  // Terminally gone: no downstream and no heartbeat for a full grace window. Drive to the terminal
  // `closed` lifecycle (the reverse leg of #172's `connecting`→`ready`), retire the record's timers,
  // then evict from the session + worker-channel maps so `GET /api/sessions` ("ccctl attach") stops
  // listing it, and reap the session's UI event relay (#176) so it does not accumulate across evictions.
  endDownstream(record); // canonical record teardown — clears any residual timers before dropping it.
  state.sessions.set(sessionId, markSessionClosed(session));
  state.sessions.delete(sessionId);
  state.workerChannels.delete(sessionId);
  closeSessionRelay(state.eventRelays, sessionId); // #176: end subscribers + drop the relay entry.
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
