// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over three channels, all SESSION-ADDRESSED (#20) so more than one running
 * session can be carried at once:
 *   - list:       a fetch() GET of `/api/sessions` enumerates the sessions the
 *     daemon is carrying (#20); the user picks one to view + steer.
 *   - downstream: an EventSource (Server-Sent Events) on `/api/sessions/{id}/events`
 *     receives the control_event frames the server relays from the SELECTED session's
 *     Claude Code worker (#15) — never another session's (#20);
 *   - upstream:   fetch() POSTs one of three steer verbs — input / approve /
 *     redirect — to `/api/sessions/{id}/command`, which the server re-frames as a
 *     control_request onto THAT session's worker channel (#16/#20).
 *
 * This shell is deliberately thin: every decode/classify/format decision lives
 * in the DOM-free `./transcript.js` (unit-tested), and every verb→frame decision
 * in the DOM-free `./command.js` (unit-tested). Here we only wire DOM controls to
 * those builders and apply their results to the page. Selecting a session (re)opens
 * its stream and clears the prior session's transcript; a `worker_status` frame
 * updates the CURRENT-TURN indicator in place; every other control event is
 * appended to the TRANSCRIPT; an undecodable line is surfaced verbatim rather
 * than dropped; and an accepted steer is echoed into the transcript (marked
 * outbound) so it is reflected in the viewed session.
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

/** A one-line label for a session in the list: its id and its state. */
function sessionLabel(session) {
  const activity = session.activity && typeof session.activity.kind === "string" ? session.activity.kind : "unknown";
  return `${session.id} — ${session.status} / ${activity}`;
}

/** Render the session picker; the selected session is marked so its highlight shows. */
function renderSessionList(sessions) {
  sessionListEl.replaceChildren();
  if (sessions.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No sessions yet.";
    sessionListEl.appendChild(li);
    return;
  }
  for (const session of sessions) {
    const li = document.createElement("li");
    li.dataset.sessionId = session.id;
    if (session.id === currentSessionId) {
      li.dataset.selected = "true";
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = sessionLabel(session);
    button.addEventListener("click", () => selectSession(session.id));
    li.appendChild(button);
    sessionListEl.appendChild(li);
  }
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

/** Fetch and render the session list; auto-select the first on first load, drop a vanished selection. */
async function loadSessions() {
  let payload;
  try {
    const response = await fetch(SESSIONS_PATH);
    if (!response.ok) {
      throw new Error(`list failed (${response.status})`);
    }
    payload = await response.json();
  } catch (error) {
    statusEl.textContent = `could not list sessions: ${error.message}`;
    return;
  }
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  renderSessionList(sessions);
  if (currentSessionId === null && sessions.length > 0) {
    // Nothing selected yet: view the first session so the UI is useful on first load.
    selectSession(sessions[0].id);
  } else if (currentSessionId !== null && !sessions.some((session) => session.id === currentSessionId)) {
    // The selected session is gone: stop viewing it.
    disconnect();
    currentSessionId = null;
    statusEl.textContent = "no session selected";
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
    headers: { "content-type": "application/json" },
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

// refresh: re-list the sessions the daemon is carrying.
refreshSessionsEl.addEventListener("click", () => {
  loadSessions();
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

loadSessions();
