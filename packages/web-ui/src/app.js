// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over two channels:
 *   - downstream: an EventSource (Server-Sent Events) receives control_event
 *     frames the server relays from the Claude Code worker;
 *   - upstream:   fetch() POSTs UI commands, which the server re-frames as
 *     control_request frames onto the worker channel.
 *
 * This is a skeleton: the endpoints below describe the intended contract.
 */

const statusEl = document.getElementById("status");
const eventsEl = document.getElementById("events");
const formEl = document.getElementById("prompt-form");
const inputEl = document.getElementById("prompt-input");

/** Same-origin server endpoints. */
const ENDPOINTS = {
  events: "/api/events", // GET (text/event-stream)
  command: "/api/command", // POST (application/json)
};

function append(text) {
  const li = document.createElement("li");
  li.textContent = text;
  eventsEl.appendChild(li);
}

/** Subscribe to the downstream control-event stream. */
function connect() {
  const source = new EventSource(ENDPOINTS.events);

  source.addEventListener("open", () => {
    statusEl.textContent = "connected";
  });

  source.addEventListener("message", (event) => {
    append(event.data);
  });

  source.addEventListener("error", () => {
    statusEl.textContent = "disconnected — retrying…";
    // EventSource reconnects automatically; nothing else to do here.
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
    append(`error: ${error.message}`);
  });
});

connect();
