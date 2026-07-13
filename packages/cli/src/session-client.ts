// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `/api/sessions` HTTP client the `ccctl launch` / `ccctl attach` / `ccctl steer` verbs drive
 * against an ALREADY-RUNNING daemon (#38 began it, #72 completes it) — the same "act on a running
 * server" posture as the `tunnel` verb, not an in-process embed.
 *
 * Going through the daemon (rather than launching a terminal in-process) is what makes a
 * CLI-launched session land in the SAME `/api/sessions` collection the phone drives — so it
 * appears in the list "alongside phone-driven ones" AND is steerable from the CLI exactly as the
 * phone steers it (the issue's second AC). The three calls that make up the launch/attach UX:
 *
 *   - `launch` → `POST /api/sessions` (UC2): run the daemon's injected launcher and report the
 *     surface's {@link https://ccctl | TerminalAttachment} (how to attach the new terminal).
 *   - `list`   → `GET  /api/sessions` (UC1 on-ramp): enumerate the running sessions to attach to.
 *   - `steer`  → `POST /api/sessions/{id}/command` (UC1 completion): push a steer verb worker-ward
 *     on ONE addressed session, the CLI-side "take over and drive it". Resolves with the daemon's
 *     minted correlation id.
 *
 * The client asserts against the daemon's PINNED wire types ({@link LaunchAcceptedWire} /
 * {@link SessionSummaryWire}, re-exported by `@ccctl/server`), so a server wire change breaks
 * this typecheck rather than drifting silently. Modelled on the e2e harness's client helpers:
 * each round-trip is time-boxed, checks the exact success status, and fails closed with a clear
 * message — a wrong status or a shape mismatch throws, and `cli.ts` turns the rejection into a
 * non-zero exit.
 */

import { formatAuthority, type HostEndpoint } from "@ccctl/core";
import type { LaunchAcceptedWire, SessionLaunchOptions, SessionSummaryWire } from "@ccctl/server";

/** How long a CLI round-trip to the daemon waits before it is treated as hung (matches the e2e harness). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One steer to push at a session — the `{ subtype, payload? }` body the CLI POSTs to
 * `POST /api/sessions/{id}/command`, mirroring the server's steer contract (`ui-command.ts`) and
 * the web UI's steer verbs (`@ccctl/web-ui`'s `command.js`). The `subtype` selects the worker
 * frame (`prompt` → a user turn; `approve` / `interrupt` → a control request); the optional
 * `payload` carries the verb's argument. The correlation id is the SERVER's to mint, never the
 * client's, so it is not part of this body.
 */
export interface SteerCommand {
  /** The steer verb the daemon maps to a worker frame (`prompt` / `approve` / `interrupt`). */
  readonly subtype: string;
  /** Verb-specific argument (`{ text }` / `{ reason }` / `{ toolUseId }`), omitted for a bare approve. */
  readonly payload?: Record<string, unknown>;
}

/**
 * The client seam the launch/attach verbs orchestrate over — the `/api/sessions` calls that make up
 * the launch/attach UX (#38 began it with `launch` + `list`, #72 completes it with `steer`). An
 * injectable port (alongside the daemon / tunnel / patcher seams) so
 * {@link https://ccctl | buildProgram} is unit-testable with a fake — no real socket, no running
 * daemon. Production wires {@link defaultSessionClient}.
 */
export interface SessionClient {
  /** `POST /api/sessions` on `target` — launch a session (UC2); resolve with the surface's attach info. */
  launch(target: HostEndpoint, options: SessionLaunchOptions): Promise<LaunchAcceptedWire>;
  /** `GET /api/sessions` on `target` — the sessions the daemon is carrying (EVERY origin, not just CLI-launched). */
  list(target: HostEndpoint): Promise<SessionSummaryWire[]>;
  /**
   * `POST /api/sessions/{id}/command` on `target` — steer the ONE addressed session (UC1
   * completion): push a `{ subtype, payload? }` steer worker-ward. Resolve with the daemon's
   * minted correlation id (the `202` body's `{ id }`).
   */
  steer(target: HostEndpoint, sessionId: string, command: SteerCommand): Promise<string>;
}

/** Render a loopback `host:port` target as its `http://…/api/sessions` URL (IPv6-bracketing via formatAuthority). */
function sessionsUrl(target: HostEndpoint): string {
  return `http://${formatAuthority(target.host, target.port)}/api/sessions`;
}

/**
 * Render the per-session steer URL — `…/api/sessions/{id}/command`. The session id is a
 * server-minted UUID (no embedded `/`), so it goes on the path verbatim, matching the server's
 * exact segment split ({@link https://ccctl | matchUiSessionRoute}) and the web UI's
 * `sessionCommandPath` — no encoding step to drift between the two.
 */
function sessionCommandUrl(target: HostEndpoint, sessionId: string): string {
  return `${sessionsUrl(target)}/${sessionId}/command`;
}

/**
 * Map a non-`201` `POST /api/sessions` status to a clear, actionable CLI error. The daemon fails
 * closed per branch (`ui-session-launch.ts`): `501` when it has no launcher wired — the common
 * case against today's `serve`, whose launch backend lands in a later wave — and `502` when every
 * backend could bring up no surface. Any other status is surfaced verbatim so a drift stays loud.
 */
function launchError(status: number): Error {
  if (status === 501) {
    return new Error(
      "ccctl: the daemon has no session launcher configured — it cannot launch sessions yet " +
        "(the launch backend lands in a later wave). Is this the right server?",
    );
  }
  if (status === 502) {
    return new Error("ccctl: the daemon could bring up no session terminal (no launcher backend available)");
  }
  return new Error(`ccctl: launch failed — POST /api/sessions returned ${status}`);
}

/**
 * Map a non-`202` `POST /api/sessions/{id}/command` status to a clear, actionable CLI error. The
 * daemon fails closed per branch (`ui-command.ts`): `404` when it carries no such session (a wrong
 * id, or one that has ended), `409` when the session exists but has no LIVE worker channel yet —
 * nothing is connected to steer (the launched worker registers over the bridge in a later wave) —
 * and `400` on a body it rejects (a client/server drift). Any other status is surfaced verbatim so
 * a drift stays loud.
 */
function steerError(status: number, sessionId: string): Error {
  if (status === 404) {
    return new Error(
      `ccctl: no session ${sessionId} on the daemon (it may have ended) — run \`ccctl attach\` to see the running sessions.`,
    );
  }
  if (status === 409) {
    return new Error(
      `ccctl: session ${sessionId} has no live worker yet — it cannot be steered until its worker connects`,
    );
  }
  if (status === 400) {
    return new Error(`ccctl: the daemon rejected the steer as malformed — POST /api/sessions/${sessionId}/command 400`);
  }
  return new Error(`ccctl: steer failed — POST /api/sessions/${sessionId}/command returned ${status}`);
}

/**
 * The production {@link SessionClient}: real `fetch` calls to the daemon's `/api/sessions`
 * namespace, each time-boxed via {@link AbortSignal.timeout} and fail-closed on an unexpected
 * status or a mis-shaped body. A connect failure (the daemon is not running) rejects from `fetch`
 * itself — `cli.ts` turns that into a non-zero exit carrying the underlying message.
 */
export const defaultSessionClient: SessionClient = {
  async launch(target: HostEndpoint, options: SessionLaunchOptions): Promise<LaunchAcceptedWire> {
    const res = await fetch(sessionsUrl(target), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 201) {
      throw launchError(res.status);
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { attachable?: unknown }).attachable !== "boolean" ||
      typeof (body as { hint?: unknown }).hint !== "string"
    ) {
      throw new Error("ccctl: POST /api/sessions did not return a { attachable, hint } body");
    }
    return body as LaunchAcceptedWire;
  },
  async list(target: HostEndpoint): Promise<SessionSummaryWire[]> {
    const res = await fetch(sessionsUrl(target), {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      throw new Error(`ccctl: could not list sessions — GET /api/sessions returned ${res.status}`);
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) {
      throw new Error("ccctl: GET /api/sessions did not return a { sessions: [...] } body");
    }
    return (body as { sessions: SessionSummaryWire[] }).sessions;
  },
  async steer(target: HostEndpoint, sessionId: string, command: SteerCommand): Promise<string> {
    const res = await fetch(sessionCommandUrl(target, sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 202) {
      throw steerError(res.status, sessionId);
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || typeof (body as { id?: unknown }).id !== "string") {
      throw new Error("ccctl: POST /api/sessions/{id}/command did not return an { id } body");
    }
    return (body as { id: string }).id;
  },
};
