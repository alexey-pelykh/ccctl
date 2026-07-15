// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — unread "needs-you" queue reconcile + ack decisions (pure, DOM-free).
 *
 * The CLIENT half of the reliability ladder's rung-3 backstop (#53); the SERVER half (#47) built the
 * persisted unread queue and its pure operations (`@ccctl/server` `unread-queue.ts`). The ladder has
 * three rungs: live SSE delivery (rung 1, #43) reaches a CONNECTED client; a Web-Push wake (rung 2,
 * #45/#46/#50) pulls a BACKGROUNDED one back — but push is at-most-once (coalesced away, dropped on
 * expiry, silently lost on a lapsed subscription). Rung 3 is the guarantee: every blocking
 * `requires_action` ("needs-you") event is ALSO enqueued to a persisted queue and RECONCILED on the
 * next reconnect, so **the queue, not the at-most-once push, is the source of truth**. This module owns
 * the client's reconcile decisions — where `push.js` owns the wake-subscription decisions and
 * `transcript.js` the live-frame decisions — so they are unit-testable without a browser; `app.js`
 * (the thin shell) fetches the queue on reconnect, surfaces each un-acked entry as a per-session picker
 * badge, and acks a session's entries when the operator views it.
 *
 * **Over the TUNNEL, not the push.** "Reconcile over the tunnel" means the reliable `fetch()` path the
 * session-list heartbeat already rides (`app.js`'s `loadSessions`), NOT the
 * at-most-once push: the reconcile is a plain HTTP GET the client issues whenever that heartbeat
 * (re)connects, so a needs-you whose push never arrived is recovered the moment the phone is reachable
 * again. It is cross-session by construction — the queue is one hub-global set (each entry tagged with
 * its `UnreadEntry.sessionId`) — so a lost wake for a session the operator is not
 * even viewing still re-surfaces.
 *
 * **Mirror-ahead of the server route (the `push.js`/`devices.js`/`pairing.js` stance).** #47 shipped
 * the queue OPERATIONS pure and deliberately UNWIRED — there is no reconcile / ack HTTP route yet
 * (`unread-queue.ts`: "pure + unwired, by design"). This slice ships the client surface against a
 * MIRRORED contract and mirror-ahead routes ({@link NEEDS_YOU_RECONCILE_PATH},
 * {@link NEEDS_YOU_ACK_PATH}), exactly as `push.js` (#51) posted to `/api/push/subscription` before
 * #50 served it: until the server wires the routes, the reconcile GET simply yields nothing (a 404 the
 * shell reads as "no queue") and the surface stays quiet — an honest walking-skeleton, not a throw.
 *
 * The `@ccctl/core` `UnreadEntry` shape is MIRRORED here as a doc constant,
 * deliberately NOT imported (this module is served to the browser as-is — no bundler — so it stays
 * dependency-free vanilla ESM), the same tradeoff `transcript.js` / `push.js` make for the wire shapes:
 *
 *   UnreadEntry = { sessionId: string, eventId: number, at: number,
 *                   activity: { kind: "requires_action", detail: string } }
 *   sessionId — the session the blocking event belongs to (the ack scope; `eventId` is per-session).
 *   eventId   — the per-session SSE `Last-Event-ID` (the monotonic cursor, from 1) the event was
 *               broadcast under. BOTH the ORDER key (a session's entries deliver in `eventId` order —
 *               AC2's "uses Last-Event-ID to order delivery") and the ACK key.
 *   at        — epoch millis the activity became unread; wall-clock provenance for display, NEVER the
 *               order key (it can tie within a millisecond).
 *   activity  — the unseen `requires_action` activity; its `detail` is the one-line human text.
 *
 * **Acknowledged == absent (ack-by-removal), and the server's set decides membership.** #47 models
 * acknowledgement as REMOVAL from the queue — there is no `acked` flag — so the un-acked set the
 * reconcile returns IS exactly "what still needs you" (AC2: "the server's un-acked set decides
 * membership"). The client renders precisely that set and, when the operator views a session,
 * {@link needsYouAckBody} acks its entries by the `(sessionId, eventId)` key the server's `ackUnread`
 * removes by — so a later reconnect no longer returns them (AC3: "acknowledged events are not
 * re-shown"). Crucially, an un-viewed entry is NOT acked on mere receipt: it re-surfaces on EVERY
 * reconnect until the operator actually attends to the session — which is the whole point of the
 * backstop ("a seen-but-unacked blocking event is re-surfaced").
 */

/**
 * The browser-facing route the UI GETs the hub-global un-acked "needs-you" set from on reconnect
 * (`{ unread: UnreadEntry[] }`) — mirror-ahead of #47's still-unwired reconcile route. A GLOBAL
 * collection (sibling of `/api/sessions`, `/api/devices`), because the queue is hub-global and the
 * reconcile is cross-session: one fetch recovers every session's un-acked blocking events at once.
 */
export const NEEDS_YOU_RECONCILE_PATH = "/api/needs-you";

/**
 * The browser-facing route the UI POSTs an ack to — the body is the {@link needsYouAckBody}
 * `{ sessionId, eventId }` key the server's `ackUnread` (#47) removes an entry by. Mirror-ahead of the
 * still-unwired ack route; a per-`(sessionId, eventId)` ack is symmetric with the global reconcile.
 */
export const NEEDS_YOU_ACK_PATH = "/api/needs-you/ack";

/**
 * The `activity.kind` a blocking "needs-you" entry carries — mirrors `@ccctl/core`'s
 * `SessionActivity` `requires_action` variant. The unread queue holds ONLY blocking `requires_action`
 * events (#47), so {@link decodeUnreadEntry} fails closed on any other kind.
 */
export const REQUIRES_ACTION_KIND = "requires_action";

/**
 * The human line a needs-you falls back to when its `activity.detail` is absent or blank — mirrors
 * `@ccctl/core`'s `DEFAULT_REQUIRES_ACTION_DETAIL` (and `transcript.js`'s live-frame fallback), so a
 * re-surfaced needs-you badge is never blank.
 */
export const DEFAULT_NEEDS_YOU_DETAIL = "Awaiting input.";

/**
 * Decode one wire value into a well-formed `UnreadEntry`, or `null` when it is not one. Fail-closed
 * over arbitrary decoded shapes, the same posture as `transcript.js`'s `decodeControlEvent` and
 * `devices.js`'s `isRenderableDevice`: a missing / blank `sessionId`, a non-integer or `< 1` `eventId`
 * (the server's cursor is a monotonic integer from 1), a non-finite `at`, or an `activity` that is not a
 * `requires_action` with a string `detail`, each fails to `null` — so one malformed element can never
 * badge a phantom session or throw. Returns a FRESH normalized entry (no aliasing of the wire object).
 *
 * @param {unknown} value - one element of a reconcile response's `unread` array, or any value.
 * @returns {{ sessionId: string, eventId: number, at: number, activity: { kind: "requires_action", detail: string } } | null}
 */
export function decodeUnreadEntry(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { sessionId, eventId, at, activity } = value;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return null;
  }
  if (!Number.isInteger(eventId) || eventId < 1) {
    return null;
  }
  if (!Number.isFinite(at)) {
    return null;
  }
  if (
    typeof activity !== "object" ||
    activity === null ||
    Array.isArray(activity) ||
    activity.kind !== REQUIRES_ACTION_KIND ||
    typeof activity.detail !== "string"
  ) {
    return null;
  }
  return { sessionId, eventId, at, activity: { kind: REQUIRES_ACTION_KIND, detail: activity.detail } };
}

/**
 * Reconcile a `GET /api/needs-you` response body into the ordered un-acked "needs-you" set (AC2). Reads
 * `payload.unread`, drops any malformed element via {@link decodeUnreadEntry}, and orders the survivors:
 * a session's entries ascend by `eventId` (the "ordered by `Last-Event-ID`" AC — a per-session total
 * order), and sessions are grouped deterministically by `sessionId` (since `eventId` is a per-session
 * cursor, it cannot order ACROSS sessions — so `sessionId` breaks the cross-session tie, giving a stable
 * delivery order rather than the wire's incidental one).
 *
 * **Membership is the server's set, verbatim** (AC2: "the server's un-acked set decides membership"):
 * this returns exactly the entries the server still holds un-acked, filtered only for well-formedness —
 * it applies no client cursor and drops nothing on age, so a needs-you whose push was lost is delivered
 * even after the live SSE cursor has advanced far past it. Defensive over a tunnel-interposed error page
 * exactly like `loadSessions` / `loadDevices` read `payload?.sessions` / `payload?.devices`: a shapeless
 * or route-not-wired-yet body yields `[]` (an honest empty queue), never a throw.
 *
 * @param {{ unread?: unknown } | null | undefined} payload - the decoded response body, or any value.
 * @returns {Array<{ sessionId: string, eventId: number, at: number, activity: { kind: "requires_action", detail: string } }>}
 */
export function reconcileNeedsYou(payload) {
  const raw = Array.isArray(payload?.unread) ? payload.unread : [];
  const entries = [];
  for (const value of raw) {
    const entry = decodeUnreadEntry(value);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries.sort((left, right) => {
    if (left.sessionId !== right.sessionId) {
      return left.sessionId < right.sessionId ? -1 : 1;
    }
    return left.eventId - right.eventId;
  });
}

/**
 * The ack request body for one entry — the `(sessionId, eventId)` key the server's `ackUnread` (#47)
 * removes by — or `null` when the entry lacks a usable key, so `app.js` never POSTs a keyless ack. The
 * result is a fresh object (no aliasing). Keyed on BOTH fields because `eventId` is a per-session cursor:
 * the same integer names different events in different sessions, so the session must scope the ack.
 *
 * @param {{ sessionId?: unknown, eventId?: unknown } | null | undefined} entry
 * @returns {{ sessionId: string, eventId: number } | null}
 */
export function needsYouAckBody(entry) {
  const sessionId = entry?.sessionId;
  const eventId = entry?.eventId;
  if (typeof sessionId !== "string" || sessionId.trim() === "" || !Number.isInteger(eventId) || eventId < 1) {
    return null;
  }
  return { sessionId, eventId };
}

/**
 * A stable string key `${sessionId}:${eventId}` for one entry, or `null` when it lacks a usable key.
 * `app.js` tracks the keys it has already acked-by-viewing in a `Set`, so a reconcile that fires again
 * before the server has processed the ack does not re-badge an entry the operator already attended to.
 * Reuses {@link needsYouAckBody}'s validation so the key and the ack agree on what a usable entry is.
 *
 * @param {{ sessionId?: unknown, eventId?: unknown } | null | undefined} entry
 * @returns {string | null}
 */
export function needsYouKey(entry) {
  const body = needsYouAckBody(entry);
  return body === null ? null : `${body.sessionId}:${body.eventId}`;
}

/**
 * The one-line human text a re-surfaced needs-you shows (the badge's `title`) — the entry's
 * `activity.detail`, falling back to {@link DEFAULT_NEEDS_YOU_DETAIL} when it is absent or blank, so the
 * surface is never empty. Mirrors `transcript.js`'s `activityText` for a live `requires_action` frame.
 *
 * @param {{ activity?: { detail?: unknown } } | null | undefined} entry
 * @returns {string}
 */
export function needsYouDetail(entry) {
  const detail = entry?.activity?.detail;
  return typeof detail === "string" && detail.trim() !== "" ? detail : DEFAULT_NEEDS_YOU_DETAIL;
}
