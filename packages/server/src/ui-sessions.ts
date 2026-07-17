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
 *   - `POST /api/sessions/{id}/stop`     → emergency-stop that session (#76). Served by
 *                                          `ui-session-stop.ts`.
 *
 * {@link matchUiSessionRoute} is the single seam that classifies a `/api/sessions…`
 * path into `list` / `events` / `command` / `stop` (+ the addressed session id), mirroring the
 * worker channel's {@link matchWorkerRoute} (`/v1/code/sessions/{id}/worker/…`). The
 * session id is a server-minted UUID (no embedded `/`), so segment splitting is exact.
 *
 * The list is the "list" half of the walking skeleton's multi-session AC ("list + view
 * + steer each"): it surfaces each session's OWN already-modelled state (its id,
 * transport `status`, derived `activity`, and its life-long `notificationsDegraded`
 * marker — #26) so a client can enumerate the sessions it is carrying, pick one to view
 * / steer, and see which ones run non-prompting (they auto-approve some class of permission
 * decision rather than prompting on it; advisory only — #265).
 * Per-session STATUS-tracking hardening beyond this surface is a sibling item
 * (#21); this handler only projects the state the session model already holds.
 *
 * Browser-facing auth is deferred (see `event-stream.ts`) — the loopback ingress is
 * unauthenticated at this slice.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInputAwaited,
  type RequiresActionEnrichment,
  type Session,
  type SessionActivity,
  type SessionStatus,
} from "@ccctl/core";
import { sessionMessageCursor, type SessionEventRelays } from "./event-stream.js";
import { writeError, writeJson } from "./http-response.js";

/** The base path of the browser-facing session namespace (`GET` lists; `/{id}/…` addresses one). */
export const UI_SESSIONS_PATH = "/api/sessions";

/** A matched `/api/sessions…` route: the list, or a per-session leg plus the session it addresses. */
export type UiSessionRoute =
  | { readonly kind: "list" }
  | { readonly kind: "events"; readonly sessionId: string }
  | { readonly kind: "command"; readonly sessionId: string }
  | { readonly kind: "stop"; readonly sessionId: string };

/**
 * Match a path against the browser-facing session namespace — `/api/sessions` (list),
 * `/api/sessions/{id}/events` (view), `/api/sessions/{id}/command` (steer),
 * `/api/sessions/{id}/stop` (emergency-stop, #76) — returning the matched leg (+ the
 * addressed session id), or `null` when it is not one of them. Mirrors
 * {@link matchWorkerRoute}: the session id is a server-minted UUID (no embedded `/`), so
 * segment splitting is exact, and an unknown sub-leg fails to match (→ a fail-closed 404
 * at the caller) rather than being served.
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
  if (tail.length === 2 && tail[1] === "stop") {
    return { kind: "stop", sessionId };
  }
  return null;
}

/** The per-server state the session list reads: the sessions tracked by this server + their SSE relays. */
export interface UiSessionsState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /**
   * The per-session SSE relays — read (never mutated) for each session's message cursor (#80),
   * the last event id emitted on its stream ({@link sessionMessageCursor}). A structural subset of
   * the server's {@link SessionEventRelays}, so this module stays decoupled from the HTTP wiring.
   */
  readonly eventRelays: SessionEventRelays;
  /**
   * The per-session `AskUserQuestion` enrichment buffer (#264), keyed by ccctl session id — read (never
   * mutated) so the list surfaces the outstanding question + tappable options for a session blocked in
   * `requires_action` (#87 renders it; #86 validates the answer against it). Present ONLY while the block
   * stands: the worker channel buffers it on the §5 `input_request` frame and drops it on transition out.
   * The verbatim SSE relay carries the raw frame LIVE; this read is what a UI that connected afterwards
   * reads instead of missing it. A structural subset of the server's map, so this module stays decoupled.
   */
  readonly requiresActionEnrichments: ReadonlyMap<string, RequiresActionEnrichment>;
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
   * #26): `true` for a non-prompting session (it auto-approves some class of permission decision
   * rather than prompting the operator on it), `false` otherwise. A persistent badge the attach
   * flow surfaces — ccctl derives it once and never re-reads the mode, so it never clears (it can
   * therefore go stale if the operator changes mode mid-run, which ccctl does not track — #272).
   *
   * ADVISORY, and narrower than its name (#265). A marked session still emits `requires_action`
   * and still raises needs-you when the agent asks a question — `AskUserQuestion` blocks natively
   * even in bypass (ADR-005 / #263). It carries FEWER triggers, not none. Nor does `true` mean the
   * session never prompts: that holds for `bypassPermissions`, but `acceptEdits` auto-accepts only
   * file edits and still prompts for other tools — and this one boolean cannot tell them apart.
   * Clients render it as a standing property of how the session was launched; they must NOT read
   * it as "this session cannot notify you" nor use it to suppress a needs-you.
   */
  readonly notificationsDegraded: boolean;
  /**
   * The session's monotonic message cursor ({@link sessionMessageCursor}, #80): the last event id
   * emitted on its stream, 0 when it has emitted nothing yet. The stale-guard's authority — the UI
   * records the cursor it last viewed and, on a steer, prompts "moved on — still send?" if the
   * session has advanced past it. Rides the list the picker already polls, so the UI reads it for
   * every session (including one it is not viewing, whose offline-queued steer must still be guarded).
   */
  readonly cursor: number;
  /**
   * The session's outstanding `AskUserQuestion` enrichment ({@link RequiresActionEnrichment}, #264), or
   * OMITTED when the session is not blocking on a decorated `requires_action` block. The buffered
   * question + tappable options a UI renders (#87) and validates an answer against (#86); it rides the
   * list the picker already polls, exactly as {@link cursor} does, so a client that connected after the
   * §5 `input_request` frame was relayed still learns of the block. DISPLAY data only — its presence NEVER
   * implies needs-you (that is `activity.kind === "requires_action"`, the sole #40 signal); a
   * `requires_action` with no enrichment still blocks, and this field is simply absent.
   */
  readonly enrichment?: RequiresActionEnrichment;
}

/**
 * Project a {@link Session} to its {@link SessionSummaryWire} — the intentional list
 * face (id + status + activity + the notifications-degraded marker + the message cursor),
 * not the whole internal snapshot (the createdAt / heartbeat timing fields stay
 * server-internal). The cursor is read from the session's SSE relay ({@link
 * sessionMessageCursor}, #80), which lives outside the {@link Session} model — hence the
 * `relays` parameter. An explicit wire projection, matching the codebase's explicit-DTO
 * discipline (session-create-wire, bridge-wire).
 */
function sessionSummary(
  session: Session,
  relays: SessionEventRelays,
  enrichments: ReadonlyMap<string, RequiresActionEnrichment>,
): SessionSummaryWire {
  const summary: SessionSummaryWire = {
    id: session.id,
    status: session.status,
    activity: session.activity,
    notificationsDegraded: session.notificationsDegraded,
    cursor: sessionMessageCursor(relays, session.id),
  };
  // Serve the buffered enrichment ONLY while the session is genuinely blocking on `requires_action`
  // ({@link isInputAwaited}) — so a decoration never surfaces on a session with no live block at all (a
  // lone `input_request` a misbehaving worker sent without a `requires_action` stays buffered but
  // unserved). The gate is blocking-PRESENCE only: it does NOT match the buffered `sequenceNum` against
  // the live block's, so it cannot guarantee this enrichment decorates the CURRENT block rather than a
  // superseded one — that per-block correlation (join-on-`sequence_num` / discard-on-mismatch) is #87's
  // job, not #264's. OMIT the key otherwise rather than emit a literal `undefined`, matching the
  // codebase's absent-optional discipline (a present key means a real, outstanding payload). Reading
  // needs-you off `activity`, never off this field, stays the sole #40 contract.
  const enrichment = isInputAwaited(session.activity) ? enrichments.get(session.id) : undefined;
  return enrichment === undefined ? summary : { ...summary, enrichment };
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
  const sessions = [...state.sessions.values()].map((session) =>
    sessionSummary(session, state.eventRelays, state.requiresActionEnrichments),
  );
  writeJson(res, 200, { sessions });
}
