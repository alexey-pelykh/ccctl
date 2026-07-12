// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Session-create response wire DTO — the server HTTP boundary's single, testable
 * seam between `@ccctl/core`'s internal model and the bytes on the foreign
 * transport.
 *
 * `@ccctl/core`'s {@link SessionCreateResponse} stays idiomatic camelCase
 * (`{ sessionId }`) — the hub model is not bent to a foreign wire. The response
 * body, however, is **snake_case** (`{ session_id }`): it is exchanged with Claude
 * Code's own Agent-SDK `stream-json` (`--sdk-url`) control transport, whose
 * convention is snake_case and whose session identifier is universally
 * `session_id` — decided on primary-source SDK/CLI evidence in ADR-001. This
 * `{ session_id }` body is the §2 session-create response (`POST /v1/sessions`).
 *
 * There is NO `ws_url`: the observed `--sdk-url` control path is SSE, never a
 * WebSocket, and never reads a `ws_url` off this response (issue #130). The worker
 * reaches the per-session channel (§4/§5) via the work-secret's `api_base_url`
 * instead. Dropping `ws_url` here is the server side of that conformance.
 *
 * This module is the ONE place that crosses that camel↔snake boundary.
 * {@link toSessionCreateResponseWire} is the mapper; a golden/contract test pins the
 * exact serialized bytes so any drift (a renamed key, a reverted casing, a
 * resurrected `ws_url`) fails closed in CI (bridge-protocol §2). Keeping the whole
 * concern here means a future wire change is one edit in this mapper plus its golden —
 * core and its internal consumers do not move.
 *
 * @see docs/decisions/adr-001-register-response-wire-casing.md
 */

import type { SessionCreateResponse } from "@ccctl/core";

/**
 * The exact on-the-wire shape of the §2 session-create response body — snake_case
 * per ADR-001, deliberately asymmetric with core's camelCase
 * {@link SessionCreateResponse}. The field order here is the serialized key order
 * the golden test pins.
 */
export interface SessionCreateResponseWire {
  /** Server-assigned session identifier (maps from {@link SessionCreateResponse.sessionId}). */
  readonly session_id: string;
}

/**
 * Serialize core's camelCase {@link SessionCreateResponse} into the snake_case
 * {@link SessionCreateResponseWire} body. The explicit boundary seam ADR-001 requires:
 * the §2 session-create handler writes `toSessionCreateResponseWire(response)` rather
 * than the core object directly, so the wire casing is a deliberate, golden-tested
 * mapping and never an accident of core's internal field names.
 */
export function toSessionCreateResponseWire(response: SessionCreateResponse): SessionCreateResponseWire {
  return {
    session_id: response.sessionId,
  };
}
