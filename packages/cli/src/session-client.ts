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
import {
  isLaunchFailureCode,
  isStopFailureCode,
  type LaunchAcceptedWire,
  type LaunchFailureCode,
  type SessionLaunchOptions,
  type SessionStopOptions,
  type SessionSummaryWire,
  type StopAcceptedWire,
  type StopFailureCode,
} from "@ccctl/server";

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
  /**
   * `POST /api/sessions/{id}/stop` on `target` — STOP the ONE addressed session (#77): kill its
   * terminal and drive it to its terminal state. Resolve with what the stop DID
   * ({@link StopAcceptedWire}); reject on every path that did not stop it.
   *
   * The opposite of {@link steer} despite the adjacent route: a steer ASKS the worker to do
   * something and needs it listening; a stop kills the surface the worker runs on and needs only
   * the handle the daemon has held since it launched it.
   */
  stop(target: HostEndpoint, sessionId: string, options: SessionStopOptions): Promise<StopAcceptedWire>;
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
 * Render the per-session stop URL — `…/api/sessions/{id}/stop` (#76). The same verbatim-id
 * construction as {@link sessionCommandUrl}, and the same server-side matcher (`…/{id}/{leg}`) —
 * `stop` is simply another leg of the namespace, and deliberately NOT a `/command` subtype: a
 * command needs a live worker channel, and a session whose worker stopped answering is exactly what
 * an emergency-stop is for.
 */
function sessionStopUrl(target: HostEndpoint, sessionId: string): string {
  return `${sessionsUrl(target)}/${sessionId}/stop`;
}

/**
 * Turn a failed `POST /api/sessions` into a clear, actionable CLI error, branching on the TYPED
 * {@link LaunchFailureCode} the daemon answers (#33) rather than on the HTTP status.
 *
 * The daemon fails closed per branch (`ui-session-launch.ts`) and says WHICH failure it was in the
 * body's `code`, so the CLI can name the operator's next move precisely — a directory that does not
 * exist and a host with no terminal backend are both "the launch failed", but they are fixed by
 * completely different actions, and a status alone (both were once a flat 502) cannot tell them apart.
 *
 * The daemon's own `error` sentence is already actionable, so it is carried through verbatim as the
 * message; the code is what selects the ADDED hint. A body with no recognizable code — an older
 * daemon, or a proxy that ate it — degrades to a status-shaped message rather than throwing: a
 * client that cannot parse the failure must still report the failure.
 */
function launchError(status: number, failure: LaunchFailure | null): Error {
  if (failure === null) {
    return new Error(`ccctl: launch failed — POST /api/sessions returned ${status}`);
  }
  const hint = LAUNCH_FAILURE_HINTS[failure.code];
  return new Error(hint === undefined ? failure.error : `${failure.error}. ${hint}`);
}

/** The parsed `{ error, code }` a failed launch answers — the daemon's `LaunchFailureWire`. */
interface LaunchFailure {
  readonly error: string;
  readonly code: LaunchFailureCode;
}

/**
 * The CLI-specific next-move hint per {@link LaunchFailureCode}, ADDED to the daemon's own sentence
 * (which already says what went wrong). Only the codes where the CLI knows something the daemon does
 * not — that this is a `ccctl` command, run from a shell, by the person who can install tmux or fix
 * the path — earn a hint; the rest are already fully actionable as the daemon phrased them.
 */
const LAUNCH_FAILURE_HINTS: Partial<Record<LaunchFailureCode, string>> = {
  "launcher-absent": "Is this the right server? (a daemon without a launcher can relay sessions but not start them)",
  "at-capacity": "Run `ccctl attach` to see which sessions hold the slots",
  "invalid-cwd": "Pass an existing directory with `--cwd`",
  "backend-unavailable": "Install tmux for an attachable terminal, or build the optional `node-pty` fallback",
  "worker-not-found": "Check that the patched `claude` is installed and on PATH (`ccctl patch`)",
};

/** Read a failed launch's `{ error, code }` body, or `null` when it is not one (an older daemon, a proxy). */
async function readLaunchFailure(res: Response): Promise<LaunchFailure | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const { error, code } = body as { error?: unknown; code?: unknown };
    if (typeof error !== "string" || !isLaunchFailureCode(code)) {
      return null;
    }
    return { error, code };
  } catch {
    // A non-JSON body (a proxy's HTML error page, a truncated response) — nothing to type.
    return null;
  }
}

/** The parsed `{ error, code }` a failed stop answers — the daemon's `StopFailureWire` (#76). */
interface StopFailure {
  readonly error: string;
  readonly code: StopFailureCode;
}

/**
 * The CLI-specific next-move hint per {@link StopFailureCode}, ADDED to the daemon's own sentence
 * (which already says what went wrong). Only the codes where the CLI knows something the daemon does
 * not — that this is a `ccctl` command, run from a shell, with flags — earn a hint; for the rest the
 * daemon's own sentence is what the operator needs, and adding to it would be noise.
 *
 * `taken-over` is the hint that matters, and it is a TRANSLATION rather than an addition: the
 * daemon's sentence names its remedy in WIRE words — "re-send this stop with `{ force: true }`" —
 * which is exactly right for the browser and curl, and not something anyone can type at a shell.
 * `--force` is that same remedy spelled for this surface. Without it the daemon's advice is a dead
 * end for the operator who is holding the one thing that can act on it.
 */
const STOP_FAILURE_HINTS: Partial<Record<StopFailureCode, string>> = {
  "unknown-session": "Run `ccctl attach` to see the running sessions",
  "taken-over": "Re-run with `--force` if you are sure",
};

/** Read a failed stop's `{ error, code }` body, or `null` when it is not one (an older daemon, a proxy). */
async function readStopFailure(res: Response): Promise<StopFailure | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const { error, code } = body as { error?: unknown; code?: unknown };
    // `isStopFailureCode` is the SERVER's own guard, imported rather than re-transcribed — so a code
    // it grows is a typecheck failure here, not a silent mismatch. It fails closed on anything
    // outside the pinned set, which also stops an errno-bearing throw (those carry a string `code`
    // too) from being read as a refusal the daemon never made.
    if (typeof error !== "string" || !isStopFailureCode(code)) {
      return null;
    }
    return { error, code };
  } catch {
    // A non-JSON body (a proxy's HTML error page, a truncated response) — nothing to type.
    return null;
  }
}

/**
 * Turn a failed `POST /api/sessions/{id}/stop` into a clear, actionable CLI error, branching on the
 * TYPED {@link StopFailureCode} rather than the HTTP status — the exact shape of
 * {@link launchError}, and for a sharper reason: four distinct refusals share `409`, so the status
 * alone cannot tell "someone is driving it" from "the backend could not be read", and those are
 * fixed by completely different actions (one by `--force`, the other by nothing this shell can do).
 *
 * The daemon's own `error` sentence is already actionable, so it is carried through verbatim as the
 * message; the code selects the ADDED hint. A body with no recognizable code — an older daemon, a
 * proxy that ate it, or the ingress's own `405` (which answers no code, because no stop was
 * attempted) — degrades to a status-shaped message rather than throwing: a client that cannot parse
 * the failure must still report the failure.
 */
function stopError(status: number, sessionId: string, failure: StopFailure | null): Error {
  if (failure === null) {
    return new Error(`ccctl: stop failed — POST /api/sessions/${sessionId}/stop returned ${status}`);
  }
  const hint = STOP_FAILURE_HINTS[failure.code];
  return new Error(hint === undefined ? failure.error : `${failure.error}. ${hint}`);
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
      throw launchError(res.status, await readLaunchFailure(res));
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { sessionId?: unknown }).sessionId !== "string" ||
      typeof (body as { attachable?: unknown }).attachable !== "boolean" ||
      typeof (body as { hint?: unknown }).hint !== "string"
    ) {
      throw new Error("ccctl: POST /api/sessions did not return a { sessionId, attachable, hint } body");
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
  async stop(target: HostEndpoint, sessionId: string, options: SessionStopOptions): Promise<StopAcceptedWire> {
    const res = await fetch(sessionStopUrl(target, sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `force` rides the body as a literal boolean: the daemon's parse refuses anything else rather
      // than coercing it, so this must never stringify it (`"false"` is truthy, and truthiness in
      // the destructive direction is the one failure this verb may not have).
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      // EVERY non-200 is a throw, deliberately: a refused stop must not resolve. The operator's whole
      // reason for running this is to stop watching the session, so `ccctl stop X && echo done` must
      // not print `done` for a session that is still running — and `cli.ts` turns this rejection into
      // the non-zero exit that makes the `&&` hold.
      throw stopError(res.status, sessionId, await readStopFailure(res));
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { sessionId?: unknown }).sessionId !== "string" ||
      typeof (body as { outcome?: unknown }).outcome !== "string" ||
      typeof (body as { status?: unknown }).status !== "string"
    ) {
      // A 200 whose body we cannot read is NOT a stop we may report: the shape is how we know what
      // happened to the session, and reporting an unreadable answer as a kill is the one lie an
      // emergency-stop must never tell.
      throw new Error("ccctl: POST /api/sessions/{id}/stop did not return a { sessionId, outcome, status } body");
    }
    return body as StopAcceptedWire;
  },
};
