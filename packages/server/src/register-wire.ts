// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Register-response wire DTO — the server HTTP boundary's single, testable seam
 * between `@ccctl/core`'s internal model and the bytes on the foreign transport.
 *
 * `@ccctl/core`'s {@link RegisterResponse} stays idiomatic camelCase
 * (`{ sessionId, wsUrl }`) — the hub model is not bent to a foreign wire. The
 * `POST /v1/code/sessions` response body, however, is **snake_case**
 * (`{ session_id, ws_url }`): it is exchanged with Claude Code's own Agent-SDK
 * `stream-json` (`--sdk-url`) control transport, whose convention is snake_case
 * and whose session identifier is universally `session_id` — decided on
 * primary-source SDK/CLI evidence in ADR-001.
 *
 * This module is the ONE place that crosses that camel↔snake boundary.
 * {@link toRegisterResponseWire} is the mapper; a golden/contract test pins the
 * exact serialized bytes so any drift (a renamed key, a reverted casing, a stray
 * field) fails closed in CI (bridge-protocol §1). Keeping the whole concern here
 * means a future wire change is one edit in this mapper plus its golden — core
 * and its internal consumers do not move.
 *
 * @see docs/decisions/adr-001-register-response-wire-casing.md
 */

import type { RegisterResponse } from "@ccctl/core";

/**
 * The exact on-the-wire shape of the register response body — snake_case per
 * ADR-001, deliberately asymmetric with core's camelCase {@link RegisterResponse}.
 * The field order here is the serialized key order the golden test pins.
 */
export interface RegisterResponseWire {
  /** Server-assigned session identifier (maps from {@link RegisterResponse.sessionId}). */
  readonly session_id: string;
  /** The worker-channel WebSocket URL (maps from {@link RegisterResponse.wsUrl}). */
  readonly ws_url: string;
}

/**
 * Serialize core's camelCase {@link RegisterResponse} into the snake_case
 * {@link RegisterResponseWire} body. The explicit boundary seam ADR-001 requires:
 * the register handler writes `toRegisterResponseWire(response)` rather than the
 * core object directly, so the wire casing is a deliberate, golden-tested mapping
 * and never an accident of core's internal field names.
 */
export function toRegisterResponseWire(response: RegisterResponse): RegisterResponseWire {
  return {
    session_id: response.sessionId,
    ws_url: response.wsUrl,
  };
}
