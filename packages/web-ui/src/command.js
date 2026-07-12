// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — steer command building logic (pure, DOM-free).
 *
 * The upstream half of the zero-build UI transport pair. Where `transcript.js`
 * DECODES the `control_event` frames the server relays down the SSE stream, this
 * module ENCODES the UI's steer verbs into the `{ subtype, payload? }` command
 * bodies the browser `fetch`-POSTs to `POST /api/sessions/{id}/command` (#13,
 * session-addressed #20). The server mints the `control_request` id and re-frames
 * the command as a `@ccctl/core` `ControlRequest` onto THAT session's worker channel
 * (#12) — the browser chooses only the verb and its payload, never the correlation id
 * and never which OTHER session it lands on (the id is in the URL).
 *
 * Keeping the verb→frame mapping here (DOM-free) makes the steer contract
 * unit-testable without a browser, exactly as the decode/classify logic is; `app.js`
 * stays the thin shell that reads a DOM control, builds a command here, and POSTs it.
 *
 * The three steer verbs (issue #12 AC) and their wire subtypes are MIRRORED from
 * `@ccctl/core`, deliberately NOT imported (this module is served to the browser
 * as-is, no bundler), so it stays dependency-free vanilla ESM:
 *
 *   input    → { subtype: "prompt",    payload: { text } }        — send input to the turn
 *   approve  → { subtype: "approve",   payload: { toolUseId }? }  — approve the pending action
 *   redirect → { subtype: "interrupt", payload: { reason } }      — redirect the current turn
 */

/** Same-origin path the browser GETs the session list from (mirrors the server's `UI_SESSIONS_PATH`). */
export const SESSIONS_PATH = "/api/sessions";

/**
 * Same-origin path the browser subscribes a session's SSE stream on (`EventSource`).
 * Per session (#20), so a viewer sees only the addressed session's events.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionEventsPath(sessionId) {
  return `${SESSIONS_PATH}/${sessionId}/events`;
}

/**
 * Same-origin path the browser POSTs a steer to, per session (#20), so a steer
 * addresses exactly one session and can never land on another.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionCommandPath(sessionId) {
  return `${SESSIONS_PATH}/${sessionId}/command`;
}

/** Wire subtype of the "send input" steer (mirrors `@ccctl/core`). */
export const INPUT_SUBTYPE = "prompt";

/** Wire subtype of the "approve the pending action" steer (mirrors `@ccctl/core`). */
export const APPROVE_SUBTYPE = "approve";

/** Wire subtype of the "redirect the current turn" steer (mirrors `@ccctl/core`). */
export const REDIRECT_SUBTYPE = "interrupt";

/** Trim a value to a string, or the empty string when it is not one. */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the "send input" steer from the user's text, or `null` when the text is
 * blank so the caller no-ops rather than steering with an empty prompt. Trimmed
 * before it goes on the wire.
 *
 * @param {unknown} text
 * @returns {{ subtype: string, payload: { text: string } } | null}
 */
export function inputCommand(text) {
  const value = trimmed(text);
  if (value === "") {
    return null;
  }
  return { subtype: INPUT_SUBTYPE, payload: { text: value } };
}

/**
 * Build the "redirect the current turn" steer from the user's reason, or `null`
 * when the reason is blank. Trimmed before it goes on the wire.
 *
 * @param {unknown} reason
 * @returns {{ subtype: string, payload: { reason: string } } | null}
 */
export function redirectCommand(reason) {
  const value = trimmed(reason);
  if (value === "") {
    return null;
  }
  return { subtype: REDIRECT_SUBTYPE, payload: { reason: value } };
}

/**
 * Build the "approve the pending action" steer. The optional `toolUseId` names
 * WHICH pending tool call to approve; at this slice nothing on the wire carries a
 * tool-use identity (a `worker_status` `requires_action` frame is `{ status, detail? }`
 * only), so with no id the UI approves THE single pending action, payload omitted.
 * The parameter keeps the canonical `{ toolUseId }` shape reachable — and tested —
 * for when a later item surfaces the id downstream. Always builds (approve has no
 * required user input).
 *
 * @param {unknown} [toolUseId]
 * @returns {{ subtype: string, payload?: { toolUseId: string } }}
 */
export function approveCommand(toolUseId) {
  const value = trimmed(toolUseId);
  if (value === "") {
    return { subtype: APPROVE_SUBTYPE };
  }
  return { subtype: APPROVE_SUBTYPE, payload: { toolUseId: value } };
}

/**
 * One-line summary of a steer command, for echoing the sent steer into the viewed
 * transcript. Pulls the salient field per verb (`text` / `reason` / `toolUseId`);
 * a payload-less approve summarizes to the empty string.
 *
 * @param {{ subtype: string, payload?: Record<string, unknown> }} command
 * @returns {string}
 */
export function describeCommand(command) {
  const { payload } = command;
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.reason === "string") {
    return payload.reason;
  }
  if (typeof payload.toolUseId === "string") {
    return payload.toolUseId;
  }
  return "";
}
