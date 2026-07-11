// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The UI command ingress — the browser's `fetch` POST that steers the worker (#13).
 *
 * This is the upstream half of the zero-build UI transport pair: the browser
 * POSTs a `{ subtype, payload? }` command to `POST /api/command`, and the server
 * re-frames it as a `@ccctl/core` {@link ControlRequest} and relays it worker-ward
 * over the session's live worker channel — reusing {@link dispatchToWorkerChannel}
 * (issue #12), never re-implementing the framing. The downstream half — the SSE
 * event stream the browser reads — is `event-stream.ts`.
 *
 * The server MINTS the `control_request` id (a fresh UUID per command): the id is
 * the server's correlation handle, not the browser's to choose. The command is
 * relayed to THE session (one session at this slice); per-session addressing lands
 * with multiplexing, a later item.
 *
 * Fail-closed on every branch that is not a well-formed POST that can actually be
 * relayed: a wrong method, an over-long or malformed body, no session, or no live
 * worker channel each answer with a status, never a silent drop. Browser-facing
 * auth is deferred (see `event-stream.ts`) — the loopback ingress is unauthenticated
 * at this slice.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlRequest } from "@ccctl/core";
import { writeError, writeJson } from "./http-response.js";
import { dispatchToWorkerChannel, type WorkerChannelState } from "./worker-channel.js";

/** The same-origin path the browser POSTs UI steer commands to. */
export const COMMAND_PATH = "/api/command";

/**
 * Hard ceiling on a command body (1 MiB). Generous for a UI steer — even a large
 * pasted prompt fits — while bounding an unbuffered POST body against a malformed
 * or hostile `Content-Length`. The worker channel enforces its own 16 MiB
 * per-frame cap downstream; this is the ingress-side counterpart.
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

/** Resolve the single current session id, or `null` when none is registered. */
function currentSessionId(state: WorkerChannelState): string | null {
  for (const id of state.sessions.keys()) {
    return id;
  }
  return null;
}

/**
 * Handle `POST /api/command` — re-frame a UI steer command as a `control_request`
 * and relay it over the session's worker channel. Reads the body with a size cap,
 * validates it, then dispatches; answers `202` with the minted request id, or a
 * fail-closed status on any branch that cannot be relayed.
 */
export function handleUiCommand(req: IncomingMessage, res: ServerResponse, state: WorkerChannelState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${COMMAND_PATH}`);
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
    const sessionId = currentSessionId(state);
    if (sessionId === null) {
      writeError(res, 404, "ccctl: no session to steer");
      return;
    }
    // The server owns the correlation id; the browser does not choose it.
    const id = randomUUID();
    const request: ControlRequest =
      command.payload === undefined
        ? { type: "control_request", id, subtype: command.subtype }
        : { type: "control_request", id, subtype: command.subtype, payload: command.payload };
    try {
      dispatchToWorkerChannel(state, sessionId, request);
    } catch {
      // dispatchToWorkerChannel fails closed when the session has no live worker
      // channel (never connected, or already reaped). Surface that as a conflict
      // rather than a silent drop, so the UI learns the steer did not land.
      writeError(res, 409, `ccctl: session ${sessionId} has no live worker channel`);
      return;
    }
    writeJson(res, 202, { id });
  });

  req.on("error", () => {
    // A request-stream error (the client reset mid-body): the connection is gone,
    // so there is nothing to relay and no one to answer — drop it.
    handled = true;
  });
}
