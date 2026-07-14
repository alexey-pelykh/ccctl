// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — session-list rendering logic (pure, DOM-free).
 *
 * The "list" leg of the zero-build UI (#20/#25). Where `transcript.js` decodes ONE
 * selected session's SSE frames and `command.js` encodes its steers, this module owns
 * the decisions behind the SESSION PICKER: how a session reads as a one-line row, and —
 * so the list stays live as sessions change state (#25 AC3) — what changed between one
 * `GET /api/sessions` poll and the next, so the DOM shell can update only the rows that
 * moved instead of rebuilding the whole list every interval.
 *
 * `app.js` polls `GET /api/sessions` on an interval; each poll yields an array of
 * `SessionSummaryWire` (the server's list projection). Keeping the diff/label/selection
 * decisions here (DOM-free) makes them unit-testable without a browser, exactly as the
 * decode and steer-building logic are; the shell stays thin glue that applies the result.
 *
 * The `@ccctl/core` / server-wire shapes are MIRRORED here as constants, deliberately NOT
 * imported: this module is served to the browser as-is (no bundler, no build), so it stays
 * dependency-free vanilla ESM. The mirrored contract (`GET /api/sessions` → `{ sessions }`):
 *
 *   SessionSummaryWire = { id: string, status: SessionStatus, activity: SessionActivity }
 *   SessionStatus      = "connecting" | "ready" | "busy" | "closed" | "errored"  (transport)
 *   SessionActivity    = { kind: "running" }
 *                      | { kind: "requires_action"; detail: string }
 *                      | { kind: "idle" }                                        (what the worker is doing)
 *
 * A row surfaces BOTH dimensions: the transport `status` (is the steering channel live?)
 * and the derived activity as the human "per-session status" the issue enumerates —
 * running / idle / awaiting-input (#25 AC1), where `requires_action` reads as "awaiting
 * input".
 */

/**
 * The human per-session status a {@link SessionActivity} `kind` reads as in a list row —
 * the "running / idle / awaiting-input" vocabulary of #25 AC1 (`requires_action` is
 * "awaiting-input"). An unknown/absent kind is not mapped here and falls back in
 * {@link activityLabel}.
 */
export const ACTIVITY_LABELS = {
  running: "running",
  requires_action: "awaiting input",
  idle: "idle",
};

/**
 * The human per-session status for a session's activity — one of {@link ACTIVITY_LABELS}.
 * Defensive over arbitrary decoded shapes (a missing, null, array, or unknown-`kind`
 * activity never throws): a known kind maps to its label, an unrecognized string kind is
 * surfaced verbatim rather than hidden, and a shapeless value reads as `"unknown"`.
 *
 * @param {unknown} activity - a `SessionActivity`, or any decoded value.
 * @returns {string}
 */
export function activityLabel(activity) {
  if (
    typeof activity !== "object" ||
    activity === null ||
    Array.isArray(activity) ||
    typeof activity.kind !== "string"
  ) {
    return "unknown";
  }
  const label = ACTIVITY_LABELS[activity.kind];
  return typeof label === "string" ? label : activity.kind;
}

/**
 * The one-line label a session reads as in the picker: its id, its transport `status`,
 * and its human activity ({@link activityLabel}). Both state dimensions show because they
 * are orthogonal — a `ready` channel can be `idle` or `awaiting input`, and a `connecting`
 * / `closed` channel is worth seeing before you pick it. Defensive over a missing status.
 *
 * @param {{ id: string, status?: unknown, activity?: unknown }} session
 * @returns {string}
 */
export function sessionLabel(session) {
  const status = typeof session.status === "string" ? session.status : "unknown";
  return `${session.id} — ${status} · ${activityLabel(session.activity)}`;
}

/**
 * Diff the previously-rendered session list against the latest poll into the minimal set
 * of row edits the DOM shell applies — so the list updates in place (only the rows that
 * changed) rather than being torn down and rebuilt every interval (#25 AC3). Rebuilding
 * would re-announce the whole `aria-live` list to a screen reader each poll and drop button
 * focus / the selection mid-interaction; an in-place reconcile touches only real changes.
 *
 * Rows are keyed by session id. A row is `added` when its id is new, `removed` when its id
 * is gone, and `updated` when its id survives but its {@link sessionLabel} changed (its
 * status or activity moved) — an unchanged row yields no edit. `order` is the full id
 * sequence of the latest list (the server lists in insertion order), so the shell can
 * place new rows and reflect any reordering.
 *
 * @param {ReadonlyArray<{ id: string, status?: unknown, activity?: unknown }>} previous - the last rendered summaries.
 * @param {ReadonlyArray<{ id: string, status?: unknown, activity?: unknown }>} next - the latest poll's summaries.
 * @returns {{ order: string[], added: { id: string, label: string }[], removed: string[], updated: { id: string, label: string }[] }}
 */
export function diffSessionList(previous, next) {
  const previousLabels = new Map();
  for (const session of previous) {
    previousLabels.set(session.id, sessionLabel(session));
  }
  const order = [];
  const added = [];
  const updated = [];
  const nextIds = new Set();
  for (const session of next) {
    const { id } = session;
    order.push(id);
    nextIds.add(id);
    const label = sessionLabel(session);
    if (!previousLabels.has(id)) {
      added.push({ id, label });
    } else if (previousLabels.get(id) !== label) {
      updated.push({ id, label });
    }
  }
  const removed = [];
  for (const id of previousLabels.keys()) {
    if (!nextIds.has(id)) {
      removed.push(id);
    }
  }
  return { order, added, removed, updated };
}

/**
 * Decide what the selection should be after a list refresh, given the currently-viewed
 * session and the latest list. Encodes the two automatic moves the picker makes so the
 * view stays useful as sessions come and go:
 *
 *   - `{ kind: "select", id }` — nothing is selected yet but sessions exist: view the
 *     first so the UI is useful on first load;
 *   - `{ kind: "clear" }`     — the selected session is gone from the list: stop viewing it;
 *   - `{ kind: "keep" }`      — the selection is still valid (or there is nothing to select):
 *     leave it, so a live poll never churns the open stream of a still-present session.
 *
 * @param {string | null | undefined} currentSessionId - the viewed session, or null when none.
 * @param {ReadonlyArray<{ id: string }>} sessions - the latest list.
 * @returns {{ kind: "select", id: string } | { kind: "clear" } | { kind: "keep" }}
 */
export function nextSelection(currentSessionId, sessions) {
  if (currentSessionId === null || currentSessionId === undefined) {
    return sessions.length > 0 ? { kind: "select", id: sessions[0].id } : { kind: "keep" };
  }
  const present = sessions.some((session) => session.id === currentSessionId);
  return present ? { kind: "keep" } : { kind: "clear" };
}
