// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Minimal JSON HTTP response helpers, shared by the ccctl server's request
 * handlers (register, UI command ingress, the SSE relay's error path). One place
 * owns the `Content-Type: application/json` + status + `{ error }` body shape so
 * every fail-closed branch answers the same way.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Write a JSON body with the given status; flushes any headers already set. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(payload);
}

/** Write a `{ error }` JSON body with the given status. */
export function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
}

/** The outcome of reading a request body: the parsed JSON value, or a fail-closed status + reason. */
export type ReadJsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Read and JSON-parse an unbuffered request body under a byte cap. Fail-closed on
 * every branch that cannot yield a JSON value: an over-cap body answers `413`, a
 * malformed body `400`, and a mid-body stream error is surfaced as a `400` too
 * (there is nothing to parse). The cap bounds a hostile or malformed
 * `Content-Length` the same way the UI command ingress does — a generous ceiling
 * for a control-plane body, never an unbounded buffer.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<ReadJsonBodyResult> {
  return new Promise<ReadJsonBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: ReadJsonBodyResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settle({ ok: false, status: 413, message: `ccctl: request body exceeds the ${maxBytes}-byte cap` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
      } catch {
        settle({ ok: false, status: 400, message: "ccctl: request body is not valid JSON" });
      }
    });
    req.on("error", () => {
      settle({ ok: false, status: 400, message: "ccctl: request stream error while reading the body" });
    });
  });
}
