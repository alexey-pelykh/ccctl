// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `Authorization: Bearer …` parsing, shared by the two ccctl-server ingress
 * points that receive the account credential (bridge-protocol §4): the register
 * handler (`POST /v1/code/sessions`) and the worker-channel WebSocket upgrade.
 *
 * The helper only reports whether a usable Bearer is PRESENT — it deliberately
 * has no persistence surface of its own. Both call sites compare-and-discard the
 * result, so the account Bearer is validated for receipt and then dropped: it
 * never reaches session state, the register response, or a log (the strict
 * NON-PERSISTING pass-through the contract mandates).
 */

/**
 * Extract the token from an `Authorization: Bearer <token>` header, or `null`
 * when the header is absent, uses a different scheme, or carries an empty token.
 * The scheme match is case-insensitive (RFC 7235); the token is trimmed.
 */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const separator = header.indexOf(" ");
  if (separator === -1) {
    return null;
  }
  const scheme = header.slice(0, separator);
  const token = header.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || token === "") {
    return null;
  }
  return token;
}
