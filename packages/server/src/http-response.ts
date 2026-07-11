// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Minimal JSON HTTP response helpers, shared by the ccctl server's request
 * handlers (register, UI command ingress, the SSE relay's error path). One place
 * owns the `Content-Type: application/json` + status + `{ error }` body shape so
 * every fail-closed branch answers the same way.
 */

import type { ServerResponse } from "node:http";

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
