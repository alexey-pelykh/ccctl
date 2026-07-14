// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — connection-health verdict for the phone↔server link (pure, DOM-free).
 *
 * The zero-build UI talks to @ccctl/server over two transports (see `app.js`): an always-on
 * `fetch()` POLL of `/api/sessions` (the session-list heartbeat, #25) and, for the selected
 * session, a downstream `EventSource` STREAM of control events (#15). This module reduces the
 * live state of BOTH legs to a single always-visible connection-health verdict — `live`,
 * `reconnecting`, or `offline` (#75) — so the operator can tell at a glance whether the link
 * is up, distinct from any individual session's transport status (`app.js` `#status`) and from
 * what the worker is doing (the `#activity` worker status, which never feeds this — #75 AC2).
 *
 * Like `transcript.js` / `command.js` / `sessions.js`, the decision lives here (DOM-free) so it
 * is unit-testable without a browser; the shell stays thin glue that feeds the two legs in and
 * paints the result. The reduction is a pure snapshot of the two legs — no cross-poll memory —
 * matching the stateless shape of `sessions.js`'s `diffSessionList` / `nextSelection`.
 *
 * Leg inputs (plain strings the shell passes, mirrored — not imported):
 *   poll   — the session-list heartbeat: "pending" (no poll settled yet) | "ok" (last poll
 *            succeeded) | "failed" (last poll failed). Always present: it runs on an interval
 *            whether or not a session is selected, so it is the authority on reachability.
 *   stream — the selected session's downstream SSE: "idle" (no session / disconnected) |
 *            "connecting" (opening) | "open" | "reconnecting" (errored, auto-retrying). Absent
 *            (idle) when no session is being viewed, so it only ever REFINES the poll's verdict.
 */

/** The three states the indicator shows (#75 AC1) — 1:1 with the issue's vocabulary. */
export const LIVE = "live";
export const RECONNECTING = "reconnecting";
export const OFFLINE = "offline";

/**
 * Reduce the two transport legs to one connection-health verdict.
 *
 * The poll heartbeat is the AUTHORITY on whether the phone↔server link is up: it runs on an
 * interval regardless of selection, and steering (an upstream `fetch()` POST) rides the same
 * request path, so a failed poll means the operator cannot actually reach the server — offline,
 * even over a still-open downstream handle. With the heartbeat healthy the stream refines the
 * verdict DOWNWARD only: a stream mid-(re)connect is a live-but-degraded downstream surfaced as
 * `reconnecting`; a settled/idle stream leaves it `live`. Before the first heartbeat settles,
 * nothing is confirmed → `reconnecting` (establishing). Defensive and never-throwing: an unknown
 * or absent `poll` reads as `reconnecting` (the uncertain middle, never a false `live`), while the
 * `stream` degrades the verdict only on an explicit `connecting`/`reconnecting` — any other
 * `stream` value leaves the poll's verdict standing.
 *
 * @param {{ poll?: "pending"|"ok"|"failed", stream?: "idle"|"connecting"|"open"|"reconnecting" }} legs
 * @returns {"live"|"reconnecting"|"offline"}
 */
export function connectionHealth(legs) {
  const poll = legs?.poll;
  const stream = legs?.stream;
  // Heartbeat down → the link is down, regardless of any stale stream state.
  if (poll === "failed") {
    return OFFLINE;
  }
  // Heartbeat OK/pending: a downstream mid-(re)connect is degraded → reconnecting.
  if (stream === "connecting" || stream === "reconnecting") {
    return RECONNECTING;
  }
  // Heartbeat confirmed reachable and the stream is open or not in use → live.
  if (poll === "ok") {
    return LIVE;
  }
  // Not yet confirmed (pending) or an unknown poll value → reconnecting, never a false live.
  return RECONNECTING;
}
