// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Accepts the patched Claude Code worker's `stream-json` control channel and
 * relays it to the browser UI: control events flow downstream to the UI over
 * Server-Sent Events (SSE), and UI commands flow upstream via `fetch`, which
 * the server re-frames as {@link ControlRequest}s onto the worker channel.
 *
 * This is a skeleton: the interface fixes the intended shape; `startServer`
 * is a stub.
 */

import type { ControlEvent, ControlRequest, Session } from "@ccctl/core";

/** Configuration for a ccctl server instance. */
export interface ServerConfig {
  /** Loopback port the local HTTP server binds to. */
  port: number;
  /** Host to bind. Defaults to loopback so nothing is exposed off-box. */
  host?: string;
}

/** Default loopback bind host — nothing is exposed without an explicit tunnel. */
export const DEFAULT_HOST = "127.0.0.1";

/** A running ccctl server: the relay between worker channel and UI. */
export interface CcctlServer {
  /** Sessions currently tracked by this server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Forward a worker control event to all subscribed UI clients (SSE). */
  broadcast(sessionId: string, event: ControlEvent): void;
  /** Re-frame an inbound UI command as a control request for the worker. */
  dispatch(sessionId: string, request: ControlRequest): void;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/**
 * Start the local relay server.
 *
 * @remarks Not yet implemented — returns a typed placeholder so downstream
 * packages (`cli`) can wire against the contract.
 */
export function startServer(_config: ServerConfig): Promise<CcctlServer> {
  throw new Error("ccctl: startServer is not implemented yet (skeleton)");
}
