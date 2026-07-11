// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Terminates the patched Claude Code worker's native `stream-json` control
 * transport. This slice implements two legs of the bridge:
 *
 *   - Session registration (bridge-protocol §1): a worker `POST /v1/code/sessions`
 *     is accepted, a {@link Session} is created, and the response hands back the
 *     session **id** plus the **`ws_url`** the worker opens its worker-channel to.
 *   - The worker channel itself (bridge-protocol §2/§3): the worker then opens a
 *     WebSocket to that `ws_url` and streams `worker_status` frames, from which the
 *     server derives the session's `activity`. The upgrade is handled in
 *     {@link handleWorkerChannelUpgrade}; this module only wires it onto the HTTP
 *     server.
 *
 * The account OAuth Bearer is presented on BOTH the register request AND the
 * worker-channel WebSocket connect (bridge-protocol §4). On each, it is received
 * and treated as a strict NON-PERSISTING pass-through — its presence is required,
 * but it is never captured into session state, never logged, and never echoed: the
 * credential is validated for receipt and dropped. Forwarding it to
 * `api.anthropic.com` for the live session (via {@link AccountBearer.reveal}) lands
 * with a later item.
 *
 * UI→worker steer dispatch ({@link CcctlServer.dispatch}) relays one
 * `control_request` worker-ward over the same worker channel (bridge-protocol §2);
 * the codec (`@ccctl/core`'s control-frame encoder) and the WebSocket framing are
 * reused, never re-implemented.
 *
 * The browser-facing transport pair completes the relay (#13). Downstream: the
 * worker channel fans every inbound `control_event` out to subscribed UI clients
 * over Server-Sent Events (`GET /api/events`, {@link CcctlServer.broadcast} /
 * `handleEventStream`), each event carrying a `Last-Event-ID`-compatible id so a
 * reconnecting client reconciles the gap. Upstream: the browser steers back with a
 * `fetch` POST (`POST /api/command`, `handleUiCommand`) that re-frames the command
 * as a `control_request` and calls {@link CcctlServer.dispatch}. Browser-facing
 * auth (the deferred local-server credential boundary) is a later item — the
 * loopback UI ingress is unauthenticated at this slice.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import {
  formatAuthority,
  SESSIONS_CREATE_PATH,
  sessionFromRegister,
  type ControlEvent,
  type ControlRequest,
  type HostEndpoint,
  type RegisterResponse,
  type Session,
} from "@ccctl/core";
import { toRegisterResponseWire } from "./register-wire.js";
import { parseBearer } from "./bearer.js";
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
import { writeError, writeJson } from "./http-response.js";

// Re-export the register-response wire boundary (the snake_case DTO + mapper,
// ADR-001 / #108) on the public surface, so a contract consumer — the e2e
// harness's register round-trip (#109), a future worker client — asserts against
// the PINNED wire type instead of re-transcribing its shape. The mapper and its
// exact serialized bytes are golden-tested in register-wire.test.ts.
export { toRegisterResponseWire, type RegisterResponseWire } from "./register-wire.js";

/** Configuration for a ccctl server instance. */
export interface ServerConfig {
  /** Loopback port the local HTTP server binds to. `0` selects an ephemeral port. */
  port: number;
  /** Host to bind. Defaults to loopback so nothing is exposed off-box. */
  host?: string;
}

/** Default loopback bind host — nothing is exposed without an explicit tunnel. */
export const DEFAULT_HOST = "127.0.0.1";

/** A running ccctl server: the relay between worker channel and UI. */
export interface CcctlServer {
  /**
   * The address the server actually bound. When {@link ServerConfig.port} is `0`
   * this carries the resolved ephemeral port — so callers can always learn where
   * to reach the server, and where the `ws_url`s it mints point.
   */
  readonly address: HostEndpoint;
  /** Sessions currently tracked by this server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Forward a worker control event to all subscribed UI clients (SSE). */
  broadcast(sessionId: string, event: ControlEvent): void;
  /**
   * Relay one UI-issued steer to the worker as a control request written over the
   * session's worker-channel WebSocket (bridge-protocol §2). Throws if the session
   * has no live worker channel.
   */
  dispatch(sessionId: string, request: ControlRequest): void;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Mutable per-server state shared with the request handler. */
interface RegisterState {
  readonly sessions: Map<string, Session>;
  /**
   * The live worker-channel socket per session id. An upgraded socket is DETACHED
   * from the HTTP server, so neither `closeIdleConnections()` nor
   * `closeAllConnections()` manages it — the server tracks them here to enforce one
   * channel per session and to tear them down on {@link CcctlServer.close}.
   */
  readonly workerChannels: Map<string, Duplex>;
  /** The UI Server-Sent Events relay state — subscribers + Last-Event-ID replay buffer. */
  readonly events: EventStreamState;
  /** Provisional at construction; finalized with the resolved port once bound. */
  address: HostEndpoint;
}

/**
 * Handle one HTTP request against the register contract. Fails closed on every
 * branch that is not a well-formed `POST /v1/code/sessions` carrying the account
 * Bearer, and — at this slice — accepts a single session only.
 */
function handleRegister(req: IncomingMessage, res: ServerResponse, state: RegisterState): void {
  // Pin the build-specific path (bridge-protocol §1); anything else is a 404 so
  // a worker-transport drift is a loud wrong-endpoint miss, not a silent accept.
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname !== SESSIONS_CREATE_PATH) {
    writeError(res, 404, `ccctl: no route for ${pathname}`);
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${SESSIONS_CREATE_PATH}`);
    return;
  }

  // Bridge-protocol §4: the account Bearer must be present on the register
  // request. Validate receipt and fail closed if it is absent or malformed. The
  // caller never binds the credential — parseBearer's return is compared and
  // discarded — so it cannot reach session state, the response, or a log (there
  // is no logging in this module). Forwarding it to api.anthropic.com (via
  // AccountBearer.reveal) lands with the worker-channel item.
  if (parseBearer(req.headers.authorization) === null) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeError(res, 401, "ccctl: missing or malformed `Authorization: Bearer` credential");
    return;
  }

  // One session only at this slice; multiplexing is a later item, so a second
  // registration fails closed rather than silently replacing the live session.
  if (state.sessions.size >= 1) {
    writeError(res, 409, "ccctl: a session already exists (one session only at this slice)");
    return;
  }

  const sessionId = randomUUID();
  const response: RegisterResponse = {
    sessionId,
    wsUrl: `ws://${formatAuthority(state.address.host, state.address.port)}${SESSIONS_CREATE_PATH}/${sessionId}/ws`,
  };
  state.sessions.set(sessionId, sessionFromRegister(response));
  // Serialize through the boundary DTO: the wire body is snake_case
  // (`session_id` / `ws_url`) per ADR-001, while `response` stays core's camelCase
  // RegisterResponse. `toRegisterResponseWire` is the single, golden-tested seam
  // that owns the camel↔snake asymmetry — never write `response` to the wire
  // directly, or a future reader "fixing" the mismatch reintroduces the drift.
  writeJson(res, 201, toRegisterResponseWire(response));
}

/**
 * Route one HTTP request. The browser-facing UI transport pair is matched first —
 * `GET /api/events` (SSE relay) and `POST /api/command` (steer ingress) — and
 * everything else falls through to the worker-facing register handler, which owns
 * the `/v1/code/*` bridge surface and fails closed (404) on any other path.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, state: RegisterState): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === EVENTS_PATH) {
    handleEventStream(req, res, state.events);
    return;
  }
  if (pathname === COMMAND_PATH) {
    handleUiCommand(req, res, state);
    return;
  }
  handleRegister(req, res, state);
}

/** Assemble the public {@link CcctlServer} handle over a bound HTTP server. */
function createHandle(httpServer: Server, state: RegisterState): CcctlServer {
  return {
    address: state.address,
    sessions: state.sessions,
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
 * {@link CcctlServer} whose {@link CcctlServer.address} reports the bound host
 * and (possibly ephemeral) port. Rejects if the socket fails to bind.
 */
export function startServer(config: ServerConfig): Promise<CcctlServer> {
  const host = config.host ?? DEFAULT_HOST;
  const state: RegisterState = {
    sessions: new Map<string, Session>(),
    workerChannels: new Map<string, Duplex>(),
    events: createEventStreamState(),
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
  // points back at this server (bridge-protocol §2). Node surfaces that as an
  // `upgrade` event; `handleWorkerChannelUpgrade` fails closed on anything that is
  // not a well-formed upgrade for a known session carrying the account Bearer.
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
