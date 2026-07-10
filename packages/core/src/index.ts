// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/core` — the hub.
 *
 * Shared domain model for ccctl: the session/state model and the Claude Code
 * `stream-json` control-channel types. Every other package (`server`, `cli`,
 * `tunnel-adapters`) depends on this one; the wire contract and the session
 * model live here so there is a single source of truth.
 *
 * This is a skeleton: the shapes below capture the intended contract, not a
 * working implementation.
 */

// ---------------------------------------------------------------------------
// stream-json control channel
//
// Claude Code's `--sdk-url` worker transport frames control messages as
// newline-delimited JSON (NDJSON): one JSON object per line, `\n`-terminated.
// The control channel is bidirectional — the controller issues
// `control_request`s and the worker answers with `control_response`s (plus
// unsolicited `control_event`s for streamed progress).
// ---------------------------------------------------------------------------

/** Discriminator for every frame carried on the control channel. */
export type ControlFrameType = "control_request" | "control_response" | "control_event";

/** A controller→worker instruction. `id` correlates the eventual response. */
export interface ControlRequest {
  type: "control_request";
  /** Opaque correlation id, unique within a session. */
  id: string;
  /** The verb the worker should act on (e.g. `"interrupt"`, `"prompt"`). */
  subtype: string;
  /** Verb-specific payload; shape is defined per subtype downstream. */
  payload?: Record<string, unknown>;
}

/** A worker→controller reply to a specific {@link ControlRequest}. */
export interface ControlResponse {
  type: "control_response";
  /** Echoes the originating {@link ControlRequest.id}. */
  id: string;
  /** Whether the requested action succeeded. */
  ok: boolean;
  /** Result payload on success. */
  result?: Record<string, unknown>;
  /** Human-readable failure reason when `ok` is `false`. */
  error?: string;
}

/** An unsolicited worker→controller progress/notification frame. */
export interface ControlEvent {
  type: "control_event";
  /** Event discriminator (e.g. `"session_started"`, `"message"`). */
  subtype: string;
  /** Event-specific payload. */
  payload?: Record<string, unknown>;
}

/** Any frame that can travel on the control channel. */
export type ControlFrame = ControlRequest | ControlResponse | ControlEvent;

/**
 * Serialize a single control frame to one NDJSON line (including the trailing
 * newline the framing requires).
 */
export function encodeControlFrame(frame: ControlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Parse one NDJSON line into a {@link ControlFrame}. Callers are responsible
 * for splitting the byte stream on `\n` before handing lines here.
 *
 * @throws if the line is not a JSON object carrying a known frame `type`.
 */
export function decodeControlFrame(line: string): ControlFrame {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("ccctl: malformed control frame (missing `type`)");
  }
  const type = (value as { type: unknown }).type;
  if (type !== "control_request" && type !== "control_response" && type !== "control_event") {
    throw new Error(`ccctl: unknown control frame type: ${String(type)}`);
  }
  return value as ControlFrame;
}

// ---------------------------------------------------------------------------
// network primitives
//
// Shared by `server` (what it binds) and `tunnel-adapters` (what a tunnel
// exposes and therefore what the worker's `--sdk-url` allowlist must permit).
// ---------------------------------------------------------------------------

/** A host:port the ccctl server is reachable at. */
export interface HostEndpoint {
  host: string;
  port: number;
}

/** The loopback hosts that are always permitted without a tunnel. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** Whether a host is one of the always-allowed loopback hosts. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

// ---------------------------------------------------------------------------
// session / state model
// ---------------------------------------------------------------------------

/** Lifecycle of a single steered Claude Code session. */
export type SessionStatus = "connecting" | "ready" | "busy" | "closed" | "errored";

/** A Claude Code session under ccctl control, as tracked by the hub. */
export interface Session {
  /** ccctl-assigned session identifier (distinct from any worker-side id). */
  readonly id: string;
  /** Current lifecycle state. */
  status: SessionStatus;
  /** Epoch millis when the session was first registered. */
  readonly createdAt: number;
  /** Epoch millis of the most recent frame in either direction. */
  lastActivityAt: number;
}

/** Create a freshly-registered session in the `connecting` state. */
export function createSession(id: string, now: number = Date.now()): Session {
  return {
    id,
    status: "connecting",
    createdAt: now,
    lastActivityAt: now,
  };
}
