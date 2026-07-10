// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Terminates the patched Claude Code worker's native `stream-json` control
 * transport. This slice implements session registration (bridge-protocol §1): a
 * worker `POST /v1/code/sessions` is accepted, a {@link Session} is created, and
 * the response hands back the session **id** plus the **`ws_url`** the worker
 * opens its worker-channel WebSocket to.
 *
 * The account OAuth Bearer presented on the register request (bridge-protocol
 * §4) is received and treated as a strict NON-PERSISTING pass-through — its
 * presence is required, but it is never captured into session state, never
 * logged, and never echoed. There is no downstream consumer in this slice, so
 * the credential is validated and dropped; forwarding it to `api.anthropic.com`
 * (via {@link AccountBearer.reveal}) lands with the worker-channel item.
 *
 * Still stubs, landing in later items: the worker-channel WebSocket, the SSE
 * relay to the UI ({@link CcctlServer.broadcast}), and UI→worker command
 * dispatch ({@link CcctlServer.dispatch}).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  SESSIONS_CREATE_PATH,
  sessionFromRegister,
  type ControlEvent,
  type ControlRequest,
  type HostEndpoint,
  type RegisterResponse,
  type Session,
} from "@ccctl/core";

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
  /** Re-frame an inbound UI command as a control request for the worker. */
  dispatch(sessionId: string, request: ControlRequest): void;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Mutable per-server state shared with the request handler. */
interface RegisterState {
  readonly sessions: Map<string, Session>;
  /** Provisional at construction; finalized with the resolved port once bound. */
  address: HostEndpoint;
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header, or `null`
 * when the header is absent, uses a different scheme, or carries an empty token.
 * The scheme match is case-insensitive (RFC 7235); the token is trimmed.
 */
function parseBearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const separator = header.indexOf(" ");
  if (separator === -1) {
    return null;
  }
  const scheme = header.slice(0, separator);
  const token = header.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || token === "") {
    return null;
  }
  return token;
}

/** Format `host:port`, bracketing an IPv6 host per RFC 3986 (`[::1]:port`). */
function formatAuthority(host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${authority}:${port}`;
}

/** Write a JSON body with the given status; flushes any headers already set. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(payload);
}

/** Write a `{ error }` JSON body with the given status. */
function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
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
  writeJson(res, 201, response);
}

/** Assemble the public {@link CcctlServer} handle over a bound HTTP server. */
function createHandle(httpServer: Server, state: RegisterState): CcctlServer {
  return {
    address: state.address,
    sessions: state.sessions,
    broadcast(_sessionId: string, _event: ControlEvent): void {
      throw new Error("ccctl: broadcast (SSE relay to UI) is not implemented yet");
    },
    dispatch(_sessionId: string, _request: ControlRequest): void {
      throw new Error("ccctl: dispatch (UI command to worker) is not implemented yet");
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
        // Release idle keep-alive sockets so a quiescent server closes promptly
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
    address: { host, port: config.port },
  };

  const httpServer = createServer((req, res) => {
    try {
      handleRegister(req, res, state);
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
