// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `/api/sessions` HTTP client the `ccctl launch` / `ccctl attach` verbs drive against an
 * ALREADY-RUNNING daemon (#38) — the same "act on a running server" posture as the `tunnel`
 * verb, not an in-process embed.
 *
 * Going through the daemon (rather than launching a terminal in-process) is what makes a
 * CLI-launched session land in the SAME `/api/sessions` collection the phone drives — so it
 * appears in the list "alongside phone-driven ones" (the issue's second AC). The two calls that
 * BEGIN the launch/attach UX:
 *
 *   - `launch` → `POST /api/sessions` (UC2): run the daemon's injected launcher and report the
 *     surface's {@link https://ccctl | TerminalAttachment} (how to attach the new terminal).
 *   - `list`   → `GET  /api/sessions` (UC1 on-ramp): enumerate the running sessions to attach to.
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
 * The client seam the launch/attach verbs orchestrate over — the two `/api/sessions` calls that
 * BEGIN the launch/attach UX (#38). An injectable port (alongside the daemon / tunnel / patcher
 * seams) so {@link https://ccctl | buildProgram} is unit-testable with a fake — no real socket,
 * no running daemon. Production wires {@link defaultSessionClient}.
 */
export interface SessionClient {
  /** `POST /api/sessions` on `target` — launch a session (UC2); resolve with the surface's attach info. */
  launch(target: HostEndpoint, options: SessionLaunchOptions): Promise<LaunchAcceptedWire>;
  /** `GET /api/sessions` on `target` — the sessions the daemon is carrying (EVERY origin, not just CLI-launched). */
  list(target: HostEndpoint): Promise<SessionSummaryWire[]>;
}

/** Render a loopback `host:port` target as its `http://…/api/sessions` URL (IPv6-bracketing via formatAuthority). */
function sessionsUrl(target: HostEndpoint): string {
  return `http://${formatAuthority(target.host, target.port)}/api/sessions`;
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
};
