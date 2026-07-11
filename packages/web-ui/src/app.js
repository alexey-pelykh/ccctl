// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over two channels:
 *   - downstream: an EventSource (Server-Sent Events) receives control_event
 *     frames the server relays from the Claude Code worker (#15);
 *   - upstream:   fetch() POSTs one of three steer verbs — input / approve /
 *     redirect — which the server re-frames as a control_request onto the
 *     session's worker channel (#16).
 *
 * This shell is deliberately thin: every decode/classify/format decision lives
 * in the DOM-free `./transcript.js` (unit-tested), and every verb→frame decision
 * in the DOM-free `./command.js` (unit-tested). Here we only wire DOM controls to
 * those builders and apply their results to the page. A `worker_status` frame
 * updates the CURRENT-TURN indicator in place; every other control event is
 * appended to the TRANSCRIPT; an undecodable line is surfaced verbatim rather
 * than dropped; and an accepted steer is echoed into the transcript (marked
 * outbound) so it is reflected in the viewed session.
 */

import { processEventData } from "./transcript.js";
import { COMMAND_PATH, inputCommand, approveCommand, redirectCommand, describeCommand } from "./command.js";

const statusEl = document.getElementById("status");
const activityEl = document.getElementById("activity");
const eventsEl = document.getElementById("events");
const promptFormEl = document.getElementById("prompt-form");
const promptInputEl = document.getElementById("prompt-input");
const redirectFormEl = document.getElementById("redirect-form");
const redirectInputEl = document.getElementById("redirect-input");
const approveButtonEl = document.getElementById("approve-button");

/** Same-origin server endpoints. */
const ENDPOINTS = {
  events: "/api/events", // GET (text/event-stream)
  command: COMMAND_PATH, // POST (application/json) — mirrors the server's steer ingress
};

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

/** Subscribe to the downstream control-event stream. */
function connect() {
  const source = new EventSource(ENDPOINTS.events);

  source.addEventListener("open", () => {
    statusEl.textContent = "connected";
  });

  source.addEventListener("message", (event) => {
    handleEvent(event.data);
  });

  source.addEventListener("error", () => {
    statusEl.textContent = "disconnected — reconnecting…";
    // EventSource reconnects automatically, replaying past its Last-Event-ID;
    // the server reconciles the gap (#13), so nothing else to do here.
  });

  return source;
}

/**
 * POST one steer command upstream; the server re-frames it as a control_request
 * onto the session's worker channel and answers 202 with the minted id. On
 * success the accepted steer is echoed into the transcript (marked outbound), so
 * it is reflected in the viewed session even before the worker's own events flow
 * back down the SSE stream. A non-2xx answer surfaces as an error entry.
 */
async function sendSteer(command) {
  const response = await fetch(ENDPOINTS.command, {
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

connect();
