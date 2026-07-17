// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The UI command ingress — the browser's `fetch` POST that steers a session's worker
 * (#13, session-addressed by #20).
 *
 * This is the upstream half of the zero-build UI transport pair: the browser POSTs a
 * `{ subtype, payload? }` command to `POST /api/sessions/{id}/command`, and the server
 * pushes it worker-ward as a `client_event` frame down THAT SESSION's held-open worker
 * downstream (§4/§5), reusing `worker-channel.ts`, never re-implementing the framing.
 * The steered session is named in the URL ({@link matchUiSessionRoute}), never inferred —
 * so a steer for session A can never land on session B (#20: never cross-wired). The
 * downstream half — the SSE event stream the browser reads — is `event-stream.ts`.
 *
 * The command's `subtype` selects the frame's `payload.type` (the worker's demux key):
 *
 *   - `prompt` (send input) → a `{ type: "user" }` turn ({@link injectUserTurn}) — the
 *     user's text becomes a user message, the load-bearing turn injection (#130).
 *   - `answer` (an `AskUserQuestion` reply, #264) → a `{ type: "control_request" }` carrying a
 *     `@ccctl/core` `AnswerEnvelope` ({@link dispatchControlRequest}). The envelope is shape-validated
 *     and NORMALIZED at this boundary (a malformed one is a 400, and label normalization keeps any
 *     control character from riding an answer back to the worker); #86 layers the stateful freshness
 *     check (nonce / TTL, against the #264 buffer) on top of this transport.
 *   - any other verb (`approve` / `interrupt`) → a `{ type: "control_request" }`
 *     ({@link dispatchControlRequest}), the server MINTING the correlation id (the id is
 *     the server's handle, not the browser's to choose).
 *
 * Fail-closed on every branch that is not a well-formed POST that can actually be
 * relayed: a wrong method, an over-long or malformed body, a blank prompt, no session,
 * or no live worker channel each answer with a status, never a silent drop.
 * Browser-facing auth is deferred (see `event-stream.ts`) — the loopback ingress is
 * unauthenticated at this slice.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { answerEnvelopeFromValue, type ControlRequest } from "@ccctl/core";
import { writeError, writeJson } from "./http-response.js";
import { dispatchControlRequest, injectUserTurn, type WorkerChannelState } from "./worker-channel.js";

/** The "send input" steer verb — mapped to a `{ type: "user" }` turn injection (mirrors `@ccctl/web-ui`). */
const INPUT_SUBTYPE = "prompt";

/** The "answer an AskUserQuestion" steer verb (#264) — its payload is a `@ccctl/core` `AnswerEnvelope`. */
const ANSWER_SUBTYPE = "answer";

/**
 * Hard ceiling on a command body (1 MiB). Generous for a UI steer — even a large
 * pasted prompt fits — while bounding an unbuffered POST body against a malformed or
 * hostile `Content-Length`.
 */
const MAX_COMMAND_BODY_BYTES = 1024 * 1024;

/** A well-formed UI command: a steer verb (`subtype`) plus its optional payload. */
interface UiCommand {
  readonly subtype: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Parse and validate a command body into a {@link UiCommand}, or `null` when it is
 * not a JSON object carrying a non-empty string `subtype` (with an optional object
 * `payload`). Defensive over arbitrary bytes: invalid JSON, a non-object, a
 * missing/blank subtype, or a non-object payload all fail closed.
 */
function parseUiCommand(bodyText: string): UiCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { subtype, payload } = value as Record<string, unknown>;
  if (typeof subtype !== "string" || subtype === "") {
    return null;
  }
  if (payload === undefined) {
    return { subtype };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return { subtype, payload: payload as Record<string, unknown> };
}

/**
 * Handle `POST /api/sessions/{id}/command` — push a UI steer worker-ward as a
 * `client_event` on THAT session's worker downstream. The `sessionId` is named in the
 * URL by the caller ({@link matchUiSessionRoute}), never inferred, so a steer addresses
 * exactly one session (#20: never cross-wired). Reads the body with a size cap,
 * validates it, then relays; answers `202` with the minted correlation id, or a
 * fail-closed status on any branch that cannot be relayed (unknown session → 404,
 * no live worker → 409).
 */
export function handleUiCommand(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the session command path`);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let handled = false;

  req.on("data", (chunk: Buffer) => {
    if (handled) {
      return;
    }
    size += chunk.length;
    if (size > MAX_COMMAND_BODY_BYTES) {
      handled = true;
      writeError(res, 413, `ccctl: command body exceeds the ${MAX_COMMAND_BODY_BYTES}-byte cap`);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (handled) {
      return;
    }
    handled = true;

    const command = parseUiCommand(Buffer.concat(chunks).toString("utf8"));
    if (command === null) {
      writeError(res, 400, "ccctl: malformed command (expected JSON `{ subtype, payload? }`)");
      return;
    }
    if (!state.sessions.has(sessionId)) {
      writeError(res, 404, `ccctl: no session ${sessionId}`);
      return;
    }
    // A `prompt` steer needs a non-empty text before anything is relayed (400).
    if (command.subtype === INPUT_SUBTYPE) {
      const text = command.payload?.text;
      if (typeof text !== "string" || text.trim() === "") {
        writeError(res, 400, "ccctl: a `prompt` command requires a non-empty `payload.text`");
        return;
      }
    }
    // An `answer` steer (#264) needs a well-formed `AnswerEnvelope` payload before anything is relayed
    // (400) — the same fail-closed shape guard `@ccctl/core` mints, which #86 later extends with its
    // stateful nonce/TTL check against the buffered enrichment.
    if (command.subtype === ANSWER_SUBTYPE && answerEnvelopeFromValue(command.payload) === null) {
      writeError(res, 400, "ccctl: an `answer` command requires a well-formed `payload` AnswerEnvelope");
      return;
    }
    // The server owns the correlation id; the browser does not choose it.
    const id = randomUUID();
    try {
      relayCommand(state, sessionId, id, command);
    } catch {
      // injectUserTurn / dispatchControlRequest fail closed when the session has no
      // live worker downstream (never connected, or already reaped). Surface that as a
      // conflict rather than a silent drop, so the UI learns the steer did not land.
      writeError(res, 409, `ccctl: session ${sessionId} has no live worker channel`);
      return;
    }
    writeJson(res, 202, { id });
  });

  req.on("error", () => {
    // A request-stream error (the client reset mid-body): the connection is gone, so
    // there is nothing to relay and no one to answer — drop it.
    handled = true;
  });
}

/**
 * Relay a parsed command worker-ward: a `prompt` becomes a `{ type: "user" }` turn (the
 * `payload.text`, already validated non-empty by the caller, is the prompt), anything
 * else a `{ type: "control_request" }` carrying the server-minted `id`. Throws (via the
 * channel helpers) when there is no live downstream, which the caller maps to a `409`.
 */
function relayCommand(state: WorkerChannelState, sessionId: string, id: string, command: UiCommand): void {
  if (command.subtype === INPUT_SUBTYPE) {
    injectUserTurn(state, sessionId, command.payload?.text as string);
    return;
  }
  if (command.subtype === ANSWER_SUBTYPE) {
    // The handler already rejected a malformed answer (400), so this re-parse is non-null. Dispatching the
    // NORMALIZED envelope rather than the raw `command.payload` is the point: `answerEnvelopeFromValue`
    // strips control characters from every label, so nothing hostile rides the answer down to the worker.
    const answer = answerEnvelopeFromValue(command.payload);
    if (answer !== null) {
      dispatchControlRequest(state, sessionId, {
        type: "control_request",
        id,
        subtype: ANSWER_SUBTYPE,
        payload: { ...answer },
      });
    }
    return;
  }
  const request: ControlRequest =
    command.payload === undefined
      ? { type: "control_request", id, subtype: command.subtype }
      : { type: "control_request", id, subtype: command.subtype, payload: command.payload };
  dispatchControlRequest(state, sessionId, request);
}
