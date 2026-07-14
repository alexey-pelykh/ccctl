// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over three channels, all SESSION-ADDRESSED (#20) so more than one running
 * session can be carried at once:
 *   - list:       a fetch() GET of `/api/sessions`, POLLED on an interval, enumerates the
 *     sessions the daemon is carrying (#20) and keeps each row's per-session status live as
 *     sessions change state (#25); the user picks one to view + steer.
 *   - downstream: an EventSource (Server-Sent Events) on `/api/sessions/{id}/events`
 *     receives the control_event frames the server relays from the SELECTED session's
 *     Claude Code worker (#15) — never another session's (#20);
 *   - upstream:   fetch() POSTs one of three steer verbs — input / approve /
 *     redirect — to `/api/sessions/{id}/command`, which the server re-frames as a
 *     control_request onto THAT session's worker channel (#16/#20).
 *
 * This shell is deliberately thin: every decode/classify/format decision lives
 * in the DOM-free `./transcript.js` (unit-tested), every verb→frame decision
 * in the DOM-free `./command.js` (unit-tested), and every list diff / label /
 * selection decision in the DOM-free `./sessions.js` (unit-tested). Here we only
 * wire DOM controls to those builders and apply their results to the page. Each
 * poll updates the picker IN PLACE (only the rows that changed) so it stays live
 * without flicker; selecting a session (re)opens its stream and clears the prior
 * session's transcript; a `worker_status` frame updates the CURRENT-TURN indicator
 * in place; every other control event is appended to the TRANSCRIPT; an undecodable
 * line is surfaced verbatim rather than dropped; and an accepted steer is echoed
 * into the transcript (marked outbound) so it is reflected in the viewed session.
 */

import { processEventData } from "./transcript.js";
import {
  SESSIONS_PATH,
  sessionEventsPath,
  sessionCommandPath,
  inputCommand,
  approveCommand,
  redirectCommand,
  describeCommand,
} from "./command.js";
import { diffSessionList, nextSelection, notificationsDegraded } from "./sessions.js";
import { applyPairingToken, authHeader } from "./pairing.js";

const statusEl = document.getElementById("status");
const activityEl = document.getElementById("activity");
const eventsEl = document.getElementById("events");
const sessionListEl = document.getElementById("session-list");
const refreshSessionsEl = document.getElementById("refresh-sessions");
const promptFormEl = document.getElementById("prompt-form");
const promptInputEl = document.getElementById("prompt-input");
const redirectFormEl = document.getElementById("redirect-form");
const redirectInputEl = document.getElementById("redirect-input");
const approveButtonEl = document.getElementById("approve-button");

/** The session currently viewed + steered, or null when none is selected. */
let currentSessionId = null;
/** The active EventSource for the selected session, or null when disconnected. */
let source = null;
/** The picker rows currently in the DOM, keyed by session id, so a poll updates them in place. */
const sessionRows = new Map();
/** The session summaries last applied to the picker — the "previous" side of each poll's diff. */
let renderedSessions = [];
/** How often the picker re-polls `/api/sessions` so each row's per-session status stays live (#25 AC3). */
const SESSION_POLL_INTERVAL_MS = 2000;
/** The pending next-poll timer id, or null when no poll is scheduled. */
let pollTimer = null;
/** Whether a session-list poll is already in flight, so a manual refresh can't stack a second poll loop. */
let polling = false;
/** Whether the empty-state placeholder is up, so a poll over an empty list doesn't re-render it. */
let emptyPlaceholderShown = false;

/** Build one transcript `<li>`: a bold subtype label plus an optional human summary. */
function transcriptItem(subtype, summary) {
  const li = document.createElement("li");
  const label = document.createElement("strong");
  label.textContent = subtype;
  li.appendChild(label);
  if (summary !== "") {
    li.appendChild(document.createTextNode(` ${summary}`));
  }
  return li;
}

/** Append one control event to the transcript. */
function appendTranscript(subtype, summary) {
  eventsEl.appendChild(transcriptItem(subtype, summary));
}

/** Append a steer we sent, marked outbound so it reads as ours rather than the worker's. */
function appendOutbound(subtype, summary) {
  const li = transcriptItem(subtype, summary);
  li.dataset.outbound = "true";
  eventsEl.appendChild(li);
}

/** Append an undecodable line verbatim, marked so it reads as raw, not content. */
function appendUnparsed(raw) {
  const li = document.createElement("li");
  li.dataset.unparsed = "true";
  li.textContent = raw;
  eventsEl.appendChild(li);
}

/** Update the current-turn indicator in place (latest worker_status wins). */
function renderActivity(status, text) {
  activityEl.hidden = false;
  activityEl.dataset.status = status;
  activityEl.textContent = text;
}

/** Apply one SSE line to the page via the instruction `./transcript.js` returns. */
function handleEvent(data) {
  const instruction = processEventData(data);
  switch (instruction.kind) {
    case "activity":
      renderActivity(instruction.status, instruction.text);
      break;
    case "transcript":
      appendTranscript(instruction.subtype, instruction.summary);
      break;
    case "unparsed":
      appendUnparsed(instruction.raw);
      break;
  }
}

/**
 * A standing "notifications degraded" badge for a non-prompting session (#26/#27). It is a
 * SIBLING of the row button, never a child of it: a poll relabels a row via
 * `button.textContent = label`, which would wipe a badge nested inside the button — as a
 * sibling it survives every relabel. It carries an id so the button can point at it as its
 * accessible description ({@link createSessionRow}).
 */
function createDegradedBadge(sessionId) {
  const badge = document.createElement("span");
  badge.id = `degraded-${sessionId}`;
  badge.dataset.badge = "notifications-degraded";
  badge.textContent = "notifications degraded";
  badge.title =
    "This session runs in a non-prompting mode (acceptEdits / bypassPermissions); it won't raise needs-you notifications.";
  return badge;
}

/**
 * Build one picker row: a full-width button whose click views + steers that session, plus —
 * for a session carrying the degraded-notification marker (#26) — a standing badge (#27).
 *
 * The badge must sit OUTSIDE the button to survive a poll's relabel (see
 * {@link createDegradedBadge}), which also keeps it out of the button's accessible NAME — so a
 * screen-reader user tabbing the picker would hear the row but never the badge, and the
 * `aria-live` list would announce it only once at insertion. That is the one-time-transient
 * reading the marker is meant NOT to have, so the button points at the badge via
 * `aria-describedby`: focusing the row announces name + description, every time, for as long as
 * the session lives. (Session ids are server-minted UUIDs — valid, unique `id` tokens.)
 */
function createSessionRow(sessionId, label, degraded) {
  const li = document.createElement("li");
  li.dataset.sessionId = sessionId;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => selectSession(sessionId));
  li.appendChild(button);
  if (degraded) {
    const badge = createDegradedBadge(sessionId);
    li.appendChild(badge);
    button.setAttribute("aria-describedby", badge.id);
  }
  return li;
}

/**
 * Apply the latest session list to the picker IN PLACE via the diff `./sessions.js`
 * returns: drop vanished rows, add fresh ones, relabel only the rows whose status /
 * activity moved, and reorder to the server's list. Updating in place (rather than
 * rebuilding on every poll) keeps button focus and the current selection, and lets the
 * `aria-live` list announce only real changes instead of re-reading the whole list each
 * interval. An empty list shows a placeholder (not a tracked row).
 */
function applySessionList(sessions) {
  if (sessions.length === 0) {
    // Only (re)render the placeholder on the transition into empty, so a poll over a
    // still-empty list doesn't re-announce "No sessions yet." to the aria-live region.
    if (!emptyPlaceholderShown) {
      sessionRows.clear();
      const li = document.createElement("li");
      li.textContent = "No sessions yet.";
      sessionListEl.replaceChildren(li);
      emptyPlaceholderShown = true;
    }
    renderedSessions = [];
    return;
  }
  // Coming from the empty-state placeholder (which is not a tracked row): clear it first.
  if (emptyPlaceholderShown) {
    sessionListEl.replaceChildren();
    emptyPlaceholderShown = false;
  }
  const diff = diffSessionList(renderedSessions, sessions);
  // The degraded marker is per-session and life-long, so it is read at row birth (below),
  // not carried through the label diff — a status/activity change never toggles the badge.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const id of diff.removed) {
    sessionRows.get(id)?.remove();
    sessionRows.delete(id);
  }
  for (const { id, label } of diff.added) {
    const li = createSessionRow(id, label, notificationsDegraded(byId.get(id)));
    sessionRows.set(id, li);
    sessionListEl.appendChild(li);
  }
  for (const { id, label } of diff.updated) {
    const button = sessionRows.get(id)?.querySelector("button");
    if (button !== null && button !== undefined) {
      button.textContent = label;
    }
  }
  // Reorder to the server's list ONLY when the DOM order actually differs — appendChild
  // MOVES a node, so re-appending every poll would churn the list (and its aria-live
  // announcements) even when nothing moved. New rows append at the end, which already
  // matches the server's insertion order in the common case, so this rarely fires.
  const domOrder = [...sessionListEl.children].map((li) => li.dataset.sessionId);
  const orderMatches = domOrder.length === diff.order.length && domOrder.every((id, index) => id === diff.order[index]);
  if (!orderMatches) {
    for (const id of diff.order) {
      const li = sessionRows.get(id);
      if (li !== undefined) {
        sessionListEl.appendChild(li);
      }
    }
  }
  renderedSessions = sessions;
  markSelected();
}

/** Move the selection highlight to the current session without re-fetching the list. */
function markSelected() {
  for (const li of sessionListEl.children) {
    if (li.dataset.sessionId === currentSessionId) {
      li.dataset.selected = "true";
    } else {
      delete li.dataset.selected;
    }
  }
}

/** Fetch and reconcile the session list; auto-select the first on first load, drop a vanished selection. */
async function loadSessions() {
  let payload;
  try {
    const response = await fetch(SESSIONS_PATH, { headers: authHeader(localStorage) });
    if (!response.ok) {
      throw new Error(`list failed (${response.status})`);
    }
    payload = await response.json();
  } catch (error) {
    statusEl.textContent = `could not list sessions: ${error.message}`;
    return;
  }
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  applySessionList(sessions);
  const selection = nextSelection(currentSessionId, sessions);
  if (selection.kind === "select") {
    // Nothing selected yet: view the first session so the UI is useful on first load.
    selectSession(selection.id);
  } else if (selection.kind === "clear") {
    // The selected session is gone: stop viewing it.
    disconnect();
    currentSessionId = null;
    statusEl.textContent = "no session selected";
    markSelected();
  }
}

/** Close the active EventSource, if any. */
function disconnect() {
  if (source !== null) {
    source.close();
    source = null;
  }
}

/** Subscribe to a session's downstream control-event stream. */
function connect(sessionId) {
  statusEl.textContent = "connecting…";
  // The downstream is an EventSource, which cannot carry an Authorization header; applying the
  // paired token to the SSE stream (a query token would land in the server log, so not that)
  // is deferred to the later credentialed-wave item that also adds server-side enforcement (#74
  // applies the token to the fetch legs above; ingress is unauthenticated at this slice).
  source = new EventSource(sessionEventsPath(sessionId));

  source.addEventListener("open", () => {
    statusEl.textContent = `connected — ${sessionId}`;
  });

  source.addEventListener("message", (event) => {
    handleEvent(event.data);
  });

  source.addEventListener("error", () => {
    statusEl.textContent = "disconnected — reconnecting…";
    // EventSource reconnects automatically, replaying past its Last-Event-ID;
    // the server reconciles the gap per session (#13/#20), so nothing else to do here.
  });
}

/** View + steer a session: drop the prior stream + transcript and open this one's. */
function selectSession(sessionId) {
  if (sessionId === currentSessionId) {
    return;
  }
  disconnect();
  currentSessionId = sessionId;
  // A fresh session view starts clean — the prior session's transcript / activity is not ours.
  eventsEl.replaceChildren();
  activityEl.hidden = true;
  markSelected();
  connect(sessionId);
}

/**
 * POST one steer command upstream to the SELECTED session; the server re-frames it as
 * a control_request onto that session's worker channel and answers 202 with the minted
 * id. On success the accepted steer is echoed into the transcript (marked outbound), so
 * it is reflected in the viewed session even before the worker's own events flow back
 * down the SSE stream. A non-2xx answer surfaces as an error entry.
 */
async function sendSteer(command) {
  if (currentSessionId === null) {
    appendTranscript("error", "select a session to steer");
    return;
  }
  const response = await fetch(sessionCommandPath(currentSessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(localStorage) },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`ccctl: steer failed (${response.status})`);
  }
  appendOutbound(command.subtype, describeCommand(command));
}

/** Send a steer built from a DOM control; no-op on a blank build, surface failures. */
function steer(command) {
  if (command === null) {
    return;
  }
  sendSteer(command).catch((error) => {
    appendTranscript("error", error.message);
  });
}

/**
 * Poll the session list now, then arm the next poll so the picker's per-session status stays live.
 * A poll already in flight short-circuits (a manual refresh mid-fetch must not start a second poll
 * loop); the in-flight one re-arms the timer on completion. `finally` re-arms even on an unexpected
 * throw, so a transient failure never kills the loop.
 */
async function pollSessions() {
  if (polling) {
    return;
  }
  polling = true;
  try {
    await loadSessions();
  } finally {
    polling = false;
    scheduleNextPoll();
  }
}

/** Arm the next session-list poll — a single-shot timer re-armed after each poll (no overlap). */
function scheduleNextPoll() {
  pollTimer = setTimeout(pollSessions, SESSION_POLL_INTERVAL_MS);
}

// refresh: re-list now and restart the poll clock, so a manual refresh doesn't double-fetch.
refreshSessionsEl.addEventListener("click", () => {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
  }
  pollSessions();
});

// input: send the prompt text to the current turn.
promptFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = inputCommand(promptInputEl.value);
  if (command === null) {
    return;
  }
  promptInputEl.value = "";
  steer(command);
});

// redirect: interrupt the current turn with a new direction.
redirectFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = redirectCommand(redirectInputEl.value);
  if (command === null) {
    return;
  }
  redirectInputEl.value = "";
  steer(command);
});

// approve: let the pending action proceed.
approveButtonEl.addEventListener("click", () => {
  steer(approveCommand());
});

// Apply a scanned QR-pair token (#74) BEFORE the first request: read it from the URL fragment,
// persist it, and scrub it from the URL so the secret does not linger in the address bar / history.
// A returning paired device reuses its stored token; every fetch above then carries it as an
// Authorization: Bearer header.
applyPairingToken({ location, history, storage: localStorage });

// List now and keep polling so the picker's per-session status stays live (#25 AC3).
pollSessions();
