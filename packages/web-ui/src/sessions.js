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
 *   SessionSummaryWire = { id: string, status: SessionStatus, activity: SessionActivity,
 *                          notificationsDegraded: boolean, cursor: number }
 *   SessionStatus      = "registering" | "connecting" | "ready" | "busy" | "closed" | "errored"
 *                                                                                   (transport;
 *                        `registering` is a session ccctl LAUNCHED whose worker has not checked in
 *                        yet — it is listed so the operator watches it come up, and it is either
 *                        claimed by that registration or evicted, #33)
 *   SessionActivity    = { kind: "running" }
 *                      | { kind: "requires_action"; detail: string }
 *                      | { kind: "idle" }                                        (what the worker is doing)
 *   notificationsDegraded — a non-prompting session's persistent degraded-notification marker
 *                      (#26): carried on the wire and read by {@link notificationsDegraded} into the
 *                      standing per-row badge the shell renders (#27).
 *   cursor            — the session's monotonic message cursor (#80): the last event id emitted on
 *                      its stream, read by {@link sessionCursor} into the stale-guard the shell arms
 *                      (a steer against a session that has advanced past the cursor the operator last
 *                      viewed is held for a "moved on — still send?" confirm).
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
 * Whether a session carries the "notifications degraded" marker (#26) — a non-prompting
 * session (`acceptEdits` / `bypassPermissions`) never blocks on a decision, so it never
 * emits `requires_action` and its needs-you notifications never fire; a badge stands in
 * their place (#27). A dimension distinct from {@link sessionLabel}: the label carries the
 * live status/activity, this the marker, which is set once at attach and never cleared —
 * a fact about how the session was created, not a state that moves.
 *
 * Strict and defensive: only a literal `true` degrades (a truthy non-boolean does not), and
 * a missing field or shapeless value reads as not-degraded — so a partial or pre-#26 row
 * never shows a spurious badge, and this never throws.
 *
 * @param {{ notificationsDegraded?: unknown }} session - a `SessionSummaryWire`, or any value.
 * @returns {boolean}
 */
export function notificationsDegraded(session) {
  return session?.notificationsDegraded === true;
}

/**
 * The session's monotonic message cursor (#80) — the last event id emitted on its stream, read
 * from the `SessionSummaryWire` the picker polls. This is the "current" side the stale-guard
 * compares against the cursor the operator last viewed: a session whose cursor has advanced past
 * the viewed one has "moved on".
 *
 * Strict and defensive, so a partial / pre-#80 / hostile row never fabricates a false advance: only
 * a non-negative integer is honoured; a missing, fractional, negative, or shapeless value reads as
 * `0` (emitted nothing) rather than throwing. Since the cursor is monotonic, reading a garbled value
 * as 0 fails SAFE — it can only under-state the head, never invent a spurious "moved on".
 *
 * @param {{ cursor?: unknown }} session - a `SessionSummaryWire`, or any value.
 * @returns {number}
 */
export function sessionCursor(session) {
  const cursor = session?.cursor;
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
}

/**
 * The later (higher) of two message cursors — the MONOTONIC-advance rule the shell applies when folding
 * a freshly-sighted cursor (from the 2s poll OR the live SSE stream) into what it already knows for a
 * session (#80). Returns the larger, so a LAGGING source — a poll a beat behind the fresher live stream,
 * or an out-of-order delivery — can never REGRESS a cursor that a later steer must be compared against;
 * without this a regression would fabricate a false "moved on". The load-bearing correctness property of
 * the shell's per-session cursor bookkeeping, extracted here so it is unit-tested rather than buried in
 * the DOM shell.
 *
 * Defensive and never-throwing: `incoming` is honoured only when it is a non-negative integer, else
 * `current` stands (a garbled sighting never moves the cursor); a non-integer / negative `current` is
 * treated as `0` (nothing seen). Idempotent and commutative-in-effect — folding the same or a lower
 * sighting is a no-op.
 *
 * @param {unknown} current - the cursor already known for the session (0/garbled when none).
 * @param {unknown} incoming - a freshly-sighted cursor, or any value.
 * @returns {number}
 */
export function laterCursor(current, incoming) {
  const base = Number.isInteger(current) && current >= 0 ? current : 0;
  const next = Number.isInteger(incoming) && incoming >= 0 ? incoming : base;
  return next > base ? next : base;
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
