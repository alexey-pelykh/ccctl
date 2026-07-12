// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Terminates the current Claude Code build's native `stream-json` control transport:
 * the **environments-bridge** flow (bridge-protocol §1–§5), conformed to the worker's
 * observed wire (issue #130).
 *
 *   - §1 **Environment register** — `POST /v1/environments/bridge` (account Bearer)
 *     mints an environment id (`{ environment_id }`, no work-poll token).
 *   - §2 **Session create** — `POST /v1/sessions` (account Bearer) creates a
 *     {@link Session}, AUTO-ENQUEUES its `session` work item (with a locally-minted
 *     work-secret) for the worker to poll, and returns `{ session_id }` (no `ws_url`).
 *   - §3 **Work delivery** — `GET /v1/environments/{env}/work/poll`, long-polled and
 *     carrying NO credential, delivering a SINGLE work item (or an empty body).
 *     §1–§3 live in `environments-bridge.ts`.
 *   - §4/§5 **Per-session worker channel** — HTTP + Server-Sent Events, rooted at
 *     `/v1/code/sessions/{id}/worker` ({@link matchWorkerRoute}): `register` mints a
 *     `worker_epoch`, a held-open `events/stream` is the server→worker downstream,
 *     `events` is the batched upstream (where turn output returns), `PUT worker` is the
 *     status gate, plus `heartbeat` + `events/delivery`. Handled in `worker-channel.ts`.
 *
 * **Two-credential boundary (HARD, #130).** The account OAuth Bearer rides §1/§2 ONLY
 * and is a strict NON-PERSISTING pass-through — validated for receipt and dropped,
 * never captured into state, a response, or a log. The §3 poll carries no credential;
 * the §4/§5 channel is authorized (in the credentialed wave) by the per-session
 * ingress token the server minted into the work-secret, NEVER the account Bearer.
 *
 * **Browser-facing session namespace (#13, session-addressed by #20).** The UI transport
 * is per session: `GET /api/sessions` lists the tracked sessions; `GET
 * /api/sessions/{id}/events` subscribes to one session's Server-Sent Events stream (the
 * worker channel fans that session's upstream `worker/events` payloads (§5) out to ONLY
 * its subscribers); and `POST /api/sessions/{id}/command` steers that one session (the
 * server pushes it worker-ward as a `client_event` on the addressed session's downstream;
 * {@link CcctlServer.injectTurn} is the programmatic form). Naming the session in the URL
 * makes cross-wiring between sessions structurally impossible. Loopback UI ingress is
 * unauthenticated at this slice.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ENVIRONMENTS_BRIDGE_PATH, SESSIONS_PATH, type HostEndpoint, type Session } from "@ccctl/core";
import {
  closeWorkerChannels,
  handleWorkerDelivery,
  handleWorkerEvents,
  handleWorkerEventsStream,
  handleWorkerHeartbeat,
  handleWorkerRegister,
  handleWorkerStatus,
  hasLiveWorkerChannel,
  injectUserTurn,
  matchWorkerRoute,
  type WorkerChannelRecord,
} from "./worker-channel.js";
import {
  closeEventStreams,
  createSessionEventRelays,
  handleEventStream,
  type SessionEventRelays,
} from "./event-stream.js";
import { handleUiCommand } from "./ui-command.js";
import { handleSessionsList, matchUiSessionRoute } from "./ui-sessions.js";
import { writeError } from "./http-response.js";
import {
  DEFAULT_WORK_POLL_TIMEOUT_MS,
  handleEnvironmentRegister,
  handleSessionCreate,
  handleWorkPoll,
  matchWorkPollPath,
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

// Re-export the session-launcher port (#28) on the public surface — the backend-agnostic
// contract for bringing up a headful, locally-attachable terminal session. The tmux (#29)
// and owned-pty (#30) backends implement it; a caller (the daemon) depends only on the
// port. Type-only: the interface ships no runtime, its backends do. Defined in
// session-launcher.ts.
export type {
  ISessionLauncher,
  SessionLaunchOptions,
  LaunchedSession,
  TerminalAttachment,
} from "./session-launcher.js";

/** Configuration for a ccctl server instance. */
export interface ServerConfig {
  /** Loopback port the local HTTP server binds to. `0` selects an ephemeral port. */
  port: number;
  /** Host to bind. Defaults to loopback so nothing is exposed off-box. */
  host?: string;
  /**
   * Long-poll hold (ms) before an empty `…/work/poll` answers with an empty body.
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
   * reach the server, and the base the work-secret's `api_base_url` points at.
   */
  readonly address: HostEndpoint;
  /** Sessions currently tracked by this server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Environments registered on this server (§1), keyed by environment id. */
  readonly environments: ReadonlyMap<string, EnvironmentRecord>;
  /**
   * Inject one user turn — push a `{ type: "user" }` `client_event` down the session's
   * held-open worker downstream (§4/§5). The programmatic form of the turn a
   * `POST /api/sessions/{id}/command` `prompt` drives. Throws if the session has no live worker channel
   * (guard the call with {@link CcctlServer.hasLiveWorker}).
   */
  injectTurn(sessionId: string, prompt: string): void;
  /**
   * Whether the session has a LIVE worker channel — a real worker registered AND is
   * holding its §4/§5 downstream open ({@link CcctlServer.injectTurn}'s precondition). The
   * receiver-grounded read of "a real worker is connected", distinct from the session
   * merely existing in {@link CcctlServer.sessions}; `false` for an unknown session or one
   * whose worker has not opened (or has closed) its downstream.
   */
  hasLiveWorker(sessionId: string): boolean;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Mutable per-server state shared with the request handler and the bridge legs. */
interface ServerState {
  readonly sessions: Map<string, Session>;
  /** Environments registered via §1, keyed by environment id (owns the §3 work queue). */
  readonly environments: Map<string, EnvironmentRecord>;
  /** The live per-session worker channel (§4/§5): epoch + held-open downstream + seq. */
  readonly workerChannels: Map<string, WorkerChannelRecord>;
  /** The per-session UI Server-Sent Events relays — each session its own subscribers + replay buffer. */
  readonly eventRelays: SessionEventRelays;
  /** Long-poll hold (ms) for an empty `…/work/poll`. */
  readonly workPollTimeoutMs: number;
  /** Provisional at construction; finalized with the resolved port once bound. */
  address: HostEndpoint;
}

/**
 * Route one HTTP request. The browser-facing session namespace is matched first
 * (`GET /api/sessions` list, `GET /api/sessions/{id}/events` view, `POST
 * /api/sessions/{id}/command` steer — all session-addressed, #20), then the
 * environments-bridge legs (§1 environment register, §2 session create, §3 work poll)
 * and the §4/§5 per-session worker channel. Anything else falls through to a fail-closed
 * 404.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const uiSession = matchUiSessionRoute(pathname);
  if (uiSession !== null) {
    switch (uiSession.kind) {
      case "list":
        handleSessionsList(req, res, state);
        return;
      case "events":
        handleEventStream(req, res, state, uiSession.sessionId);
        return;
      case "command":
        handleUiCommand(req, res, state, uiSession.sessionId);
        return;
    }
  }
  if (pathname === ENVIRONMENTS_BRIDGE_PATH) {
    handleEnvironmentRegister(req, res, state);
    return;
  }
  if (pathname === SESSIONS_PATH) {
    handleSessionCreate(req, res, state);
    return;
  }
  const workEnvironmentId = matchWorkPollPath(pathname);
  if (workEnvironmentId !== null) {
    handleWorkPoll(req, res, state, workEnvironmentId);
    return;
  }
  const worker = matchWorkerRoute(pathname);
  if (worker !== null) {
    switch (worker.leg) {
      case "register":
        handleWorkerRegister(req, res, state, worker.sessionId);
        return;
      case "events-stream":
        handleWorkerEventsStream(req, res, state, worker.sessionId);
        return;
      case "events":
        handleWorkerEvents(req, res, state, worker.sessionId);
        return;
      case "events-delivery":
        handleWorkerDelivery(req, res, state, worker.sessionId);
        return;
      case "heartbeat":
        handleWorkerHeartbeat(req, res, state, worker.sessionId);
        return;
      case "status":
        handleWorkerStatus(req, res, state, worker.sessionId);
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
    injectTurn(sessionId: string, prompt: string): void {
      injectUserTurn(state, sessionId, prompt);
    },
    hasLiveWorker(sessionId: string): boolean {
      return hasLiveWorkerChannel(state, sessionId);
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
        // mid-poll hangs for up to workPollTimeoutMs. Same rationale as the SSE
        // teardown below.
        settlePendingPolls(state);
        // End open SSE streams — every session's UI relay (`/api/sessions/{id}/events`)
        // and every held-open worker downstream (`worker/events/stream`). An SSE response
        // holds its connection open indefinitely and is never "idle", so
        // `closeIdleConnections()` below would leave it and `close()` would hang waiting on it.
        closeEventStreams(state.eventRelays);
        closeWorkerChannels(state);
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
    workerChannels: new Map<string, WorkerChannelRecord>(),
    eventRelays: createSessionEventRelays(),
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
