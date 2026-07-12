// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Terminates the current Claude Code build's native `stream-json` control
 * transport: the **environments-bridge** flow (bridge-protocol §1–§4).
 *
 *   - §1 **Environment register** — `POST /v1/environments/bridge` (account Bearer)
 *     mints an environment id + a scoped work-poll token.
 *   - §2 **Session create** — `POST /v1/sessions` (account Bearer) creates a
 *     {@link Session} and returns `{ session_id, ws_url }`.
 *   - §3 **Work delivery** — `GET /v1/environments/{env}/work/poll`, long-polled and
 *     authorized by the SCOPED per-environment token (never the account Bearer),
 *     delivering `create_session` / `resume_session` / `user_turn` / `steer` work
 *     items, each acked or stopped. §1–§3 live in `environments-bridge.ts`.
 *   - §4 **Per-session worker channel** — the worker opens a WebSocket to the minted
 *     `ws_url` and streams `stream-json` frames; the server derives the session's
 *     `activity` and relays a turn/steer worker-ward. Handled in `worker-channel.ts`
 *     ({@link handleWorkerChannelUpgrade} / {@link CcctlServer.dispatch}).
 *
 * **Two-token credential boundary (HARD, #60).** The account OAuth Bearer rides
 * §1/§2/§4 and is a strict NON-PERSISTING pass-through — validated for receipt and
 * dropped, never captured into state, a response, or a log. The work-poll leg (§3)
 * is authorized INSTEAD by the scoped per-environment token, so presenting the
 * account Bearer there fails closed. (Forwarding the account Bearer to
 * `api.anthropic.com` for the live session lands with the credentialed wave; this
 * slice validates receipt only.)
 *
 * **Browser-facing transport pair (#13).** The worker channel fans every inbound
 * `control_event` out to subscribed UI clients over Server-Sent Events
 * (`GET /api/events`, {@link CcctlServer.broadcast}); the browser steers back with a
 * `fetch` POST (`POST /api/command`) re-framed as a `control_request` and relayed
 * via {@link CcctlServer.dispatch}. Loopback UI ingress is unauthenticated at this
 * slice (browser-facing auth is a later item).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  ENVIRONMENTS_BRIDGE_PATH,
  SESSIONS_PATH,
  type ControlEvent,
  type ControlRequest,
  type HostEndpoint,
  type Session,
  type WorkItem,
} from "@ccctl/core";
import { dispatchToWorkerChannel, handleWorkerChannelUpgrade } from "./worker-channel.js";
import {
  broadcastEvent,
  closeEventStreams,
  createEventStreamState,
  EVENTS_PATH,
  handleEventStream,
  type EventStreamState,
} from "./event-stream.js";
import { COMMAND_PATH, handleUiCommand } from "./ui-command.js";
import { writeError } from "./http-response.js";
import {
  DEFAULT_WORK_POLL_TIMEOUT_MS,
  enqueueWork,
  handleEnvironmentRegister,
  handleSessionCreate,
  handleWorkAck,
  handleWorkPoll,
  handleWorkStop,
  matchWorkPath,
  settlePendingPolls,
  type EnvironmentRecord,
} from "./environments-bridge.js";
import {
  DEFAULT_HOST,
  LOCAL_SERVER_AUTH_ENV,
  requireLocalServerAuth,
  resolveBindHost,
  WILDCARD_BIND_HOST,
} from "./startup.js";

// Re-export the §2 session-create response wire boundary (the snake_case DTO +
// mapper, ADR-001 / #108) on the public surface, so a contract consumer — a future
// worker client — asserts against the PINNED wire type instead of re-transcribing
// its shape. The mapper and its exact serialized bytes are golden-tested in
// session-create-wire.test.ts.
export { toSessionCreateResponseWire, type SessionCreateResponseWire } from "./session-create-wire.js";

// Re-export the baseline startup guarantees (#14) on the public surface. The daemon
// (@ccctl/cli's `serve`) applies them before binding, and any embedder gets the same
// refuse-start-without-auth + localhost-bind baseline. Defined and unit-tested in
// startup.ts; DEFAULT_HOST is also consumed internally below.
export { DEFAULT_HOST, LOCAL_SERVER_AUTH_ENV, requireLocalServerAuth, resolveBindHost, WILDCARD_BIND_HOST };

/** Configuration for a ccctl server instance. */
export interface ServerConfig {
  /** Loopback port the local HTTP server binds to. `0` selects an ephemeral port. */
  port: number;
  /** Host to bind. Defaults to loopback so nothing is exposed off-box. */
  host?: string;
  /**
   * Long-poll hold (ms) before an empty `…/work/poll` answers with an empty batch.
   * Defaults to {@link DEFAULT_WORK_POLL_TIMEOUT_MS}; a test passes a short value for
   * a deterministic timeout.
   */
  workPollTimeoutMs?: number;
}

/** A running ccctl server: the relay between the environments-bridge worker and the UI. */
export interface CcctlServer {
  /**
   * The address the server actually bound. When {@link ServerConfig.port} is `0`
   * this carries the resolved ephemeral port — so callers can always learn where to
   * reach the server, and where the `ws_url`s it mints point.
   */
  readonly address: HostEndpoint;
  /** Sessions currently tracked by this server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Environments registered on this server (§1), keyed by environment id. */
  readonly environments: ReadonlyMap<string, EnvironmentRecord>;
  /**
   * Enqueue one work item for an environment (§3 ingress) — the server-side hook a
   * UI action or launch feeds; the worker's next poll delivers it (or a held poll
   * receives it immediately). Returns `false` when the environment is unknown.
   */
  enqueueWork(environmentId: string, item: WorkItem): boolean;
  /** Forward a worker control event to all subscribed UI clients (SSE). */
  broadcast(sessionId: string, event: ControlEvent): void;
  /**
   * Relay one UI-issued steer to the worker as a control request written over the
   * session's worker-channel WebSocket (§4). Throws if the session has no live
   * worker channel.
   */
  dispatch(sessionId: string, request: ControlRequest): void;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Mutable per-server state shared with the request handler and the bridge legs. */
interface ServerState {
  readonly sessions: Map<string, Session>;
  /** Environments registered via §1, keyed by environment id (owns the §3 work queue + scoped token). */
  readonly environments: Map<string, EnvironmentRecord>;
  /**
   * The live worker-channel socket per session id. An upgraded socket is DETACHED
   * from the HTTP server, so neither `closeIdleConnections()` nor
   * `closeAllConnections()` manages it — the server tracks them here to enforce one
   * channel per session and to tear them down on {@link CcctlServer.close}.
   */
  readonly workerChannels: Map<string, Duplex>;
  /** The UI Server-Sent Events relay state — subscribers + Last-Event-ID replay buffer. */
  readonly events: EventStreamState;
  /** Long-poll hold (ms) for an empty `…/work/poll`. */
  readonly workPollTimeoutMs: number;
  /** Provisional at construction; finalized with the resolved port once bound. */
  address: HostEndpoint;
}

/**
 * Route one HTTP request. The browser-facing UI transport pair is matched first
 * (`GET /api/events`, `POST /api/command`), then the environments-bridge legs (§1
 * environment register, §2 session create, §3 work poll / ack / stop). Anything else
 * falls through to a fail-closed 404.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === EVENTS_PATH) {
    handleEventStream(req, res, state.events);
    return;
  }
  if (pathname === COMMAND_PATH) {
    handleUiCommand(req, res, state);
    return;
  }
  if (pathname === ENVIRONMENTS_BRIDGE_PATH) {
    handleEnvironmentRegister(req, res, state);
    return;
  }
  if (pathname === SESSIONS_PATH) {
    handleSessionCreate(req, res, state);
    return;
  }
  const work = matchWorkPath(pathname);
  if (work !== null) {
    switch (work.kind) {
      case "poll":
        handleWorkPoll(req, res, state, work.environmentId);
        return;
      case "ack":
        handleWorkAck(req, res, state, work.environmentId, work.workId);
        return;
      case "stop":
        handleWorkStop(req, res, state, work.environmentId, work.workId);
        return;
    }
  }
  writeError(res, 404, `ccctl: no route for ${pathname}`);
}

/** Assemble the public {@link CcctlServer} handle over a bound HTTP server. */
function createHandle(httpServer: Server, state: ServerState): CcctlServer {
  return {
    address: state.address,
    sessions: state.sessions,
    environments: state.environments,
    enqueueWork(environmentId: string, item: WorkItem): boolean {
      return enqueueWork(state, environmentId, item);
    },
    // At this single-session slice there is one event stream, so the sessionId is
    // accepted for the forthcoming per-session partition (multiplexing) but is not
    // yet used to route — the one stream IS the one session's.
    broadcast(_sessionId: string, event: ControlEvent): void {
      broadcastEvent(state.events, event);
    },
    dispatch(sessionId: string, request: ControlRequest): void {
      dispatchToWorkerChannel(state, sessionId, request);
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        // Settle any held work-polls (§3 long-poll). A poll held open on an empty
        // queue is an in-flight request `close()` waits on and an armed timer that
        // keeps the loop alive — without this, shutting down while a worker is
        // mid-poll hangs for up to workPollTimeoutMs. Same rationale as the SSE /
        // worker-channel teardown below.
        settlePendingPolls(state);
        // End open SSE streams. An SSE response holds its connection open
        // indefinitely and is never "idle", so `closeIdleConnections()` below would
        // leave it — and `close()` would hang waiting on it. Ending them lets a
        // quiescent server shut down promptly.
        closeEventStreams(state.events);
        // Tear down live worker-channel sockets explicitly. A worker channel is
        // long-lived and, once upgraded, is DETACHED from the HTTP server — so
        // `closeIdleConnections()` (and even `closeAllConnections()`) never touch it,
        // yet `close()` still waits on it at the socket layer. Without this, a
        // shutdown with a live channel hangs forever. This slice drops the channel
        // abruptly; a graceful WS close handshake is a later concern.
        for (const socket of state.workerChannels.values()) {
          socket.destroy();
        }
        // Release idle keep-alive HTTP sockets so a quiescent server closes promptly
        // instead of waiting on pooled client connections.
        httpServer.closeIdleConnections();
      });
    },
  };
}

/**
 * Start the local relay server. Resolves once it is listening, with a
 * {@link CcctlServer} whose {@link CcctlServer.address} reports the bound host and
 * (possibly ephemeral) port. Rejects if the socket fails to bind.
 */
export function startServer(config: ServerConfig): Promise<CcctlServer> {
  const host = config.host ?? DEFAULT_HOST;
  const state: ServerState = {
    sessions: new Map<string, Session>(),
    environments: new Map<string, EnvironmentRecord>(),
    workerChannels: new Map<string, Duplex>(),
    events: createEventStreamState(),
    workPollTimeoutMs: config.workPollTimeoutMs ?? DEFAULT_WORK_POLL_TIMEOUT_MS,
    address: { host, port: config.port },
  };

  const httpServer = createServer((req, res) => {
    try {
      handleRequest(req, res, state);
    } catch {
      if (!res.headersSent) {
        writeError(res, 500, "ccctl: internal server error");
      }
    }
  });

  // The worker opens its worker-channel WebSocket to the minted `ws_url`, which
  // points back at this server (§4). Node surfaces that as an `upgrade` event;
  // `handleWorkerChannelUpgrade` fails closed on anything that is not a well-formed
  // upgrade for a known session carrying the account Bearer.
  httpServer.on("upgrade", (req, socket, head) => {
    try {
      handleWorkerChannelUpgrade(req, socket, head, state);
    } catch {
      socket.destroy();
    }
  });

  return new Promise<CcctlServer>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    httpServer.once("error", onListenError);
    httpServer.listen(config.port, host, () => {
      httpServer.removeListener("error", onListenError);
      const bound = httpServer.address();
      if (typeof bound === "object" && bound !== null) {
        state.address = { host, port: bound.port };
      }
      resolve(createHandle(httpServer, state));
    });
  });
}
