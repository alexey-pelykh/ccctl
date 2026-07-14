// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The browser-facing session namespace — `/api/sessions/…` (#20).
 *
 * Multiplexing N concurrent sessions makes the UI transport SESSION-ADDRESSED: every
 * view and steer names the session it targets IN THE URL, so cross-wiring between
 * sessions is structurally impossible (the id selects the relay / channel before any
 * work happens). This module owns that namespace's routing and its one own handler:
 *
 *   - `GET  /api/sessions`               → LIST the tracked sessions ({@link handleSessionsList}).
 *   - `GET  /api/sessions/{id}/events`   → subscribe to that session's SSE stream (VIEW).
 *                                          Served by `event-stream.ts`.
 *   - `POST /api/sessions/{id}/command`  → steer that session (STEER). Served by `ui-command.ts`.
 *
 * {@link matchUiSessionRoute} is the single seam that classifies a `/api/sessions…`
 * path into `list` / `events` / `command` (+ the addressed session id), mirroring the
 * worker channel's {@link matchWorkerRoute} (`/v1/code/sessions/{id}/worker/…`). The
 * session id is a server-minted UUID (no embedded `/`), so segment splitting is exact.
 *
 * The list is the "list" half of the walking skeleton's multi-session AC ("list + view
 * + steer each"): it surfaces each session's OWN already-modelled state (its id,
 * transport `status`, derived `activity`, and its life-long `notificationsDegraded`
 * marker — #26) so a client can enumerate the sessions it is carrying, pick one to view
 * / steer, and see which ones run non-prompting (their needs-you notifications are
 * degraded). Per-session STATUS-tracking hardening beyond this surface is a sibling item
 * (#21); this handler only projects the state the session model already holds.
 *
 * Browser-facing auth is deferred (see `event-stream.ts`) — the loopback ingress is
 * unauthenticated at this slice.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session, SessionActivity, SessionStatus } from "@ccctl/core";
import { writeError, writeJson } from "./http-response.js";

/** The base path of the browser-facing session namespace (`GET` lists; `/{id}/…` addresses one). */
export const UI_SESSIONS_PATH = "/api/sessions";

/** A matched `/api/sessions…` route: the list, or a per-session leg plus the session it addresses. */
export type UiSessionRoute =
  | { readonly kind: "list" }
  | { readonly kind: "events"; readonly sessionId: string }
  | { readonly kind: "command"; readonly sessionId: string };

/**
 * Match a path against the browser-facing session namespace — `/api/sessions` (list),
 * `/api/sessions/{id}/events` (view), `/api/sessions/{id}/command` (steer) — returning
 * the matched leg (+ the addressed session id), or `null` when it is not one of them.
 * Mirrors {@link matchWorkerRoute}: the session id is a server-minted UUID (no embedded
 * `/`), so segment splitting is exact, and an unknown sub-leg fails to match (→ a
 * fail-closed 404 at the caller) rather than being served.
 */
export function matchUiSessionRoute(pathname: string): UiSessionRoute | null {
  const segments = pathname.split("/");
  // Expect ["", "api", "sessions", {id?}, {leg?}].
  if (segments.length < 3 || segments[0] !== "" || segments[1] !== "api" || segments[2] !== "sessions") {
    return null;
  }
  const tail = segments.slice(3);
  // `/api/sessions` (or a trailing slash) → the collection: LIST.
  if (tail.length === 0 || (tail.length === 1 && tail[0] === "")) {
    return { kind: "list" };
  }
  const sessionId = tail[0];
  if (sessionId === undefined || sessionId === "") {
    return null;
  }
  if (tail.length === 2 && tail[1] === "events") {
    return { kind: "events", sessionId };
  }
  if (tail.length === 2 && tail[1] === "command") {
    return { kind: "command", sessionId };
  }
  return null;
}

/** The per-server state the session list reads: the sessions tracked by this server. */
export interface UiSessionsState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
}

/** One session's projection on the `GET /api/sessions` list wire: its id + own state. */
export interface SessionSummaryWire {
  /** The ccctl session id — the handle a client uses to view (`…/{id}/events`) or steer (`…/{id}/command`). */
  readonly id: string;
  /** The session's transport lifecycle ({@link SessionStatus}). */
  readonly status: SessionStatus;
  /** The session's derived activity ({@link SessionActivity}) — running / requires_action / idle. */
  readonly activity: SessionActivity;
  /**
   * The session's life-long notifications-degraded marker ({@link Session.notificationsDegraded},
   * #26): `true` for a non-prompting session (it never emits `requires_action`, so its
   * needs-you notifications are degraded), `false` otherwise. A persistent badge the attach
   * flow surfaces — the mode cannot change mid-run, so it never clears.
   */
  readonly notificationsDegraded: boolean;
}

/**
 * Project a {@link Session} to its {@link SessionSummaryWire} — the intentional list
 * face (id + status + activity + the notifications-degraded marker), not the whole
 * internal snapshot (the createdAt / heartbeat timing fields stay server-internal). An
 * explicit wire projection, matching the codebase's explicit-DTO discipline
 * (session-create-wire, bridge-wire).
 */
function sessionSummary(session: Session): SessionSummaryWire {
  return {
    id: session.id,
    status: session.status,
    activity: session.activity,
    notificationsDegraded: session.notificationsDegraded,
  };
}

/**
 * Handle `GET /api/sessions` — list every tracked session as an array of
 * {@link SessionSummaryWire} under `{ sessions }`, in insertion (creation) order. This
 * is the "list" the multi-session UI enumerates to pick a session to view / steer. Fails
 * closed `405` on a non-GET method.
 */
export function handleSessionsList(req: IncomingMessage, res: ServerResponse, state: UiSessionsState): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${UI_SESSIONS_PATH}`);
    return;
  }
  const sessions = [...state.sessions.values()].map(sessionSummary);
  writeJson(res, 200, { sessions });
}
