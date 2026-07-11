// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — transcript rendering logic (pure, DOM-free).
 *
 * The downstream half of the zero-build UI transport pair reads `control_event`
 * frames off the server's SSE stream (`GET /api/events`, #13). Each SSE `data:`
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
 * Derive the current-turn activity a control event reports, or `null` when it is
 * not a `worker_status` frame.
 *
 * @param {{ subtype: string, payload?: unknown }} event
 * @returns {{ status: string, text: string } | null}
 */
export function activityFromEvent(event) {
  if (!isWorkerStatusEvent(event)) {
    return null;
  }
  const { status, detail } = event.payload;
  return { status, text: activityText(status, detail) };
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
 *   - `{ kind: "activity", status, text }`     — a `worker_status` current turn
 *     (rendered in place, latest wins);
 *   - `{ kind: "transcript", subtype, summary }` — any other control event
 *     (appended to the transcript in order);
 *   - `{ kind: "unparsed", raw }`              — an undecodable line (surfaced
 *     verbatim rather than dropped, so a malformed frame is visible, not silent).
 *
 * @param {string} data - one SSE `data:` line.
 * @returns {{ kind: "activity", status: string, text: string }
 *          | { kind: "transcript", subtype: string, summary: string }
 *          | { kind: "unparsed", raw: string }}
 */
export function processEventData(data) {
  const decoded = decodeControlEvent(data);
  if (!decoded.ok) {
    return { kind: "unparsed", raw: data };
  }
  const activity = activityFromEvent(decoded.event);
  if (activity !== null) {
    return { kind: "activity", status: activity.status, text: activity.text };
  }
  const entry = formatTranscriptEntry(decoded.event);
  return { kind: "transcript", subtype: entry.subtype, summary: entry.summary };
}
