// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — transcript rendering logic (pure, DOM-free).
 *
 * The downstream half of the zero-build UI transport pair reads `control_event`
 * frames off a session's SSE stream (`GET /api/sessions/{id}/events`, #13/#20). Each SSE `data:`
 * line is one `JSON.stringify(ControlEvent)` from `@ccctl/core`; this module
 * turns that raw string into a small, DOM-agnostic render instruction so the
 * classification (current-turn vs transcript vs undecodable) is unit-testable
 * without a browser. `app.js` is the thin shell that applies the instruction.
 *
 * The `@ccctl/core` shapes are MIRRORED here as constants, deliberately NOT
 * imported: this module is served to the browser as-is (no bundler, no build),
 * so it stays dependency-free vanilla ESM. The mirrored contract:
 *
 *   ControlEvent   = { type: "control_event", subtype: string, payload?: object }
 *   worker_status  = a ControlEvent whose subtype is "worker_status" and whose
 *                    payload is { status: WorkerStatus, detail?: string }
 *   WorkerStatus   = "running" | "requires_action" | "idle"
 *
 * A `worker_status` frame is the session's CURRENT TURN (what the worker is
 * doing right now), rendered as an in-place activity indicator; every other
 * control event is a TRANSCRIPT line, appended in order.
 *
 * Not everything on the stream came from the worker. The server SYNTHESIZES its
 * own frames onto the same relay, namespaced `ccctl_` so they cannot collide
 * with a real `stream-json` payload, and this module decodes the one that
 * changes what the page should DO:
 *
 *   ccctl_session_closed = { type: "ccctl_session_closed", session_id: string,
 *                            status: "closed" | "errored" }
 *
 * — the session's TERMINAL frame (#196, `@ccctl/server` § `session-close.ts`),
 * delivered just before the server ends the stream. It is why this decoder
 * exists at all: without it the stream simply stops, which is also what a dead
 * phone link looks like, so a client WATCHING a session someone else stopped
 * could not tell the two apart without re-polling the session list. Decoding it
 * is the client half of a deliberately COORDINATED change — an undecoded
 * `ccctl_` frame renders as a raw `unparsed` blob, so shipping the server frame
 * without this would have degraded the very surface it exists to inform.
 */

/** The `type` discriminator every control frame from the worker carries. */
export const CONTROL_EVENT_TYPE = "control_event";

/** The pinned `subtype` of the current-turn frame (mirrors `@ccctl/core`). */
export const WORKER_STATUS_SUBTYPE = "worker_status";

/** The tri-state a `worker_status` payload reports (mirrors `@ccctl/core`). */
export const WORKER_STATUSES = ["running", "requires_action", "idle"];

/**
 * Human-ready line shown when a `requires_action` frame carries no `detail`, so
 * the current-turn indicator is never blank. Mirrors
 * `@ccctl/core`'s `DEFAULT_REQUIRES_ACTION_DETAIL`.
 */
export const DEFAULT_REQUIRES_ACTION_DETAIL = "Awaiting input.";

/**
 * The pinned `type` of the server's TERMINAL frame (#196) — mirrors
 * `@ccctl/server` § `session-close.ts`'s `SESSION_CLOSED_EVENT_TYPE`.
 */
export const SESSION_CLOSED_EVENT_TYPE = "ccctl_session_closed";

/**
 * The terminal statuses a {@link SESSION_CLOSED_EVENT_TYPE} frame may report —
 * the closed subset of `@ccctl/core`'s `SessionStatus`, mirrored. `closed` is a
 * session that ended; `errored` is one that had already failed on its own, whose
 * diagnosis the server deliberately preserves rather than overwriting with the
 * fact that it was later stopped (`markSessionClosed`).
 *
 * A CLOSED set, checked rather than trusted — the same fail-closed posture
 * {@link isWorkerStatusEvent} takes over {@link WORKER_STATUSES}. A server that
 * one day reports a third terminal status is a coordinated change, and until it
 * is made, the honest render for a status this client does not know is the raw
 * line, not a confident "ended" over a state it cannot describe.
 */
export const TERMINAL_SESSION_STATUSES = ["closed", "errored"];

/**
 * Decode one SSE `data:` payload into a `ControlEvent`, or a failure. Never
 * throws — invalid JSON, a non-object, a non-`control_event` type, or a
 * missing/blank subtype all fail closed as `{ ok: false }`, so a single
 * malformed line can never tear down the stream (the same fail-closed posture as
 * the server-side codec).
 *
 * @param {string} data - one SSE `data:` line (a JSON-encoded control frame).
 * @returns {{ ok: true, event: { type: string, subtype: string, payload?: unknown } } | { ok: false }}
 */
export function decodeControlEvent(data) {
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return { ok: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  if (value.type !== CONTROL_EVENT_TYPE || typeof value.subtype !== "string" || value.subtype === "") {
    return { ok: false };
  }
  return { ok: true, event: value };
}

/**
 * Decode one SSE `data:` payload into the session's TERMINAL frame (#196), or
 * `null` when it is not one. The sibling of {@link decodeControlEvent} over the
 * server's own `ccctl_`-namespaced shape, and fail-closed in the same way:
 * invalid JSON, a non-object, a `type` that is not {@link SESSION_CLOSED_EVENT_TYPE},
 * or a `status` outside {@link TERMINAL_SESSION_STATUSES} all yield `null`.
 *
 * Fail-closed matters more here than for a transcript line, because the two
 * failure directions are not symmetric: a malformed frame that fell through to
 * `unparsed` shows the operator a raw line they can read, while one decoded
 * LOOSELY would announce that a session ended — and the page would close its own
 * stream on that word. Announcing a live session dead is the one wrong answer
 * this frame must never give, so a frame that is not exactly right is not this
 * frame.
 *
 * `session_id` is deliberately NOT read: the stream is per-session (#20), so the
 * frame arrived on the only stream it could have, and the client already knows
 * which session it is watching. Keying off a self-reported id would invite
 * trusting it over the channel it came in on.
 *
 * @param {string} data - one SSE `data:` line.
 * @returns {{ status: string } | null}
 */
export function decodeSessionClosed(data) {
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (value.type !== SESSION_CLOSED_EVENT_TYPE || !TERMINAL_SESSION_STATUSES.includes(value.status)) {
    return null;
  }
  return { status: value.status };
}

/**
 * The human-ready line for a session that has ended. Total over
 * {@link TERMINAL_SESSION_STATUSES} — the only statuses {@link decodeSessionClosed}
 * lets through — so it needs no defensive fallback branch that could never run.
 *
 * Both lines lead with the same words, because the fact the operator most needs
 * is the one they share: it is over. `errored` then says which of the two ways it
 * got there, since a session that failed on its own and one that was stopped are
 * different news to whoever is watching.
 *
 * @param {string} status - one of {@link TERMINAL_SESSION_STATUSES}.
 * @returns {string}
 */
export function closedText(status) {
  return status === "errored" ? "Session ended — errored." : "Session ended.";
}

/**
 * Whether a decoded control event is a well-formed `worker_status` frame — its
 * subtype is pinned AND its payload carries a known {@link WORKER_STATUSES}
 * status. Defensive over arbitrary decoded shapes: a missing, null, array, or
 * unknown-status payload is not a worker-status frame.
 *
 * @param {{ subtype: string, payload?: unknown }} event
 * @returns {boolean}
 */
export function isWorkerStatusEvent(event) {
  if (event.subtype !== WORKER_STATUS_SUBTYPE) {
    return false;
  }
  const { payload } = event;
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    WORKER_STATUSES.includes(payload.status)
  );
}

/**
 * The human-ready current-turn line for a worker status. `requires_action`
 * surfaces its `detail` (already a human line on the wire), falling back to
 * {@link DEFAULT_REQUIRES_ACTION_DETAIL} when it is absent or blank.
 *
 * @param {string} status - one of {@link WORKER_STATUSES}.
 * @param {unknown} [detail] - optional human detail from a `requires_action` frame.
 * @returns {string}
 */
export function activityText(status, detail) {
  switch (status) {
    case "running":
      return "Running…";
    case "requires_action":
      return typeof detail === "string" && detail.trim() !== "" ? detail : DEFAULT_REQUIRES_ACTION_DETAIL;
    case "idle":
      return "Idle";
    default:
      return status;
  }
}

/**
 * The #201 ordering stamp a `worker_status` frame carries (`payload.sequence_num`), or `null` when it
 * carries none. This is the JOIN key #87 correlates an `AskUserQuestion` enrichment against: the
 * enrichment (served on the session list, #264) names the block it decorates by `sequenceNum`, and the
 * block's OWN stamp rides here on the live SSE `worker_status` frame — the options render only when the
 * two agree (`enrichment.js` `enrichmentMatchesBlock`), so turn-N's options never decorate turn-N+1's
 * block. Mirrors `@ccctl/core`'s `asWorkerStatusSequence`: a valid stamp is a non-negative safe integer;
 * ABSENT (an older worker omits it) and MALFORMED both collapse to `null` — "no usable ordering signal",
 * which the join reads as unknown and fails safe on (render no options rather than possibly-stale ones).
 *
 * @param {{ sequence_num?: unknown }} payload - a `worker_status` payload (already a known-status object).
 * @returns {number | null}
 */
function workerStatusSequence(payload) {
  const value = payload.sequence_num;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Derive the current-turn activity a control event reports, or `null` when it is
 * not a `worker_status` frame. The `sequenceNum` is the block's #201 stamp
 * ({@link workerStatusSequence}) — `null` when the frame carries none — the key #87
 * joins an `AskUserQuestion` enrichment's options against.
 *
 * @param {{ subtype: string, payload?: unknown }} event
 * @returns {{ status: string, text: string, sequenceNum: number | null } | null}
 */
export function activityFromEvent(event) {
  if (!isWorkerStatusEvent(event)) {
    return null;
  }
  const { status, detail } = event.payload;
  return { status, text: activityText(status, detail), sequenceNum: workerStatusSequence(event.payload) };
}

/**
 * Summarize a control event's payload into one human line. Prefers a `text` or
 * `message` string field (the likely transcript-message shape), else falls back
 * to compact JSON; an absent or non-object payload summarizes to the empty
 * string. Honest and fail-soft over payload shapes that are not yet pinned.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function summarizePayload(payload) {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  return JSON.stringify(payload);
}

/**
 * Format a non-`worker_status` control event as a transcript entry: its subtype
 * (the label) plus a human summary of its payload.
 *
 * @param {{ subtype: string, payload?: unknown }} event
 * @returns {{ subtype: string, summary: string }}
 */
export function formatTranscriptEntry(event) {
  return { subtype: event.subtype, summary: summarizePayload(event.payload) };
}

/**
 * Turn one raw SSE `data:` line into a render instruction the DOM shell applies:
 *
 *   - `{ kind: "activity", status, text, sequenceNum }` — a `worker_status` current
 *     turn (rendered in place, latest wins); `sequenceNum` is the block's #201 stamp
 *     (`null` when absent), the key #87 joins an `AskUserQuestion` enrichment against;
 *   - `{ kind: "transcript", subtype, summary }` — any other control event
 *     (appended to the transcript in order);
 *   - `{ kind: "closed", status, text }`       — the session's terminal frame
 *     (#196): it is OVER, and this is the last event its stream will carry;
 *   - `{ kind: "unparsed", raw }`              — an undecodable line (surfaced
 *     verbatim rather than dropped, so a malformed frame is visible, not silent).
 *
 * The two decoders are tried control-event-FIRST purely so the hot path — every
 * transcript line the worker emits — parses once rather than twice. It is not
 * load-bearing: the shapes are disjoint by `type` (a `control_event` is never a
 * `ccctl_session_closed`, and vice versa), so each decoder rejects what the other
 * accepts and the order cannot change any verdict.
 *
 * @param {string} data - one SSE `data:` line.
 * @returns {{ kind: "activity", status: string, text: string, sequenceNum: number | null }
 *          | { kind: "transcript", subtype: string, summary: string }
 *          | { kind: "closed", status: string, text: string }
 *          | { kind: "unparsed", raw: string }}
 */
export function processEventData(data) {
  const decoded = decodeControlEvent(data);
  if (decoded.ok) {
    const activity = activityFromEvent(decoded.event);
    if (activity !== null) {
      return { kind: "activity", status: activity.status, text: activity.text, sequenceNum: activity.sequenceNum };
    }
    const entry = formatTranscriptEntry(decoded.event);
    return { kind: "transcript", subtype: entry.subtype, summary: entry.summary };
  }
  // Not something the worker said — it may be the server's own terminal frame (#196).
  const closed = decodeSessionClosed(data);
  if (closed !== null) {
    return { kind: "closed", status: closed.status, text: closedText(closed.status) };
  }
  return { kind: "unparsed", raw: data };
}
