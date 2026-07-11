// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over two channels:
 *   - downstream: an EventSource (Server-Sent Events) receives control_event
 *     frames the server relays from the Claude Code worker (#15);
 *   - upstream:   fetch() POSTs UI commands, which the server re-frames as
 *     control_request frames onto the worker channel (fleshed out in #16).
 *
 * This shell is deliberately thin: every decode/classify/format decision lives
 * in the DOM-free `./transcript.js` (unit-tested), and here we only apply the
 * resulting render instruction to the page. A `worker_status` frame updates the
 * CURRENT-TURN indicator in place; every other control event is appended to the
 * TRANSCRIPT; an undecodable line is surfaced verbatim rather than dropped.
 */

import { processEventData } from "./transcript.js";

const statusEl = document.getElementById("status");
const activityEl = document.getElementById("activity");
const eventsEl = document.getElementById("events");
const formEl = document.getElementById("prompt-form");
const inputEl = document.getElementById("prompt-input");

/** Same-origin server endpoints. */
const ENDPOINTS = {
  events: "/api/events", // GET (text/event-stream)
  command: "/api/command", // POST (application/json)
};

/** Append one transcript entry: a bold subtype label plus its human summary. */
function appendTranscript(subtype, summary) {
  const li = document.createElement("li");
  const label = document.createElement("strong");
  label.textContent = subtype;
  li.appendChild(label);
  if (summary !== "") {
    li.appendChild(document.createTextNode(` ${summary}`));
  }
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

/** Send a UI command upstream; the server re-frames it as a control_request. */
async function sendCommand(subtype, payload) {
  const response = await fetch(ENDPOINTS.command, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subtype, payload }),
  });
  if (!response.ok) {
    throw new Error(`ccctl: command failed (${response.status})`);
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = inputEl.value.trim();
  if (prompt === "") {
    return;
  }
  inputEl.value = "";
  sendCommand("prompt", { text: prompt }).catch((error) => {
    appendTranscript("error", error.message);
  });
});

connect();
