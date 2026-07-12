// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Wire DTOs for the environments-bridge flow — the server HTTP boundary's
 * snake_case seam between `@ccctl/core`'s camelCase model and the bytes on the
 * Claude Code `--sdk-url` control transport (ADR-001's convention, extended from
 * the register response to the whole flow).
 *
 * Two directions cross here, both fail-closed:
 *
 *   - **Incoming request bodies** (worker → server) are parsed snake_case → core
 *     camelCase by the `parse…` guards. Each is DEFENSIVE over arbitrary bytes off
 *     the wire: a missing/mistyped field, or — for session-create — an unknown
 *     `permission_mode`, yields `null` (a `400`, never a half-typed value). This is
 *     the "fail closed on protocol drift" contract at the ingress edge, mirroring
 *     core's own `workItemFromValue` / `isPermissionMode` discriminant validation.
 *   - **Outgoing responses** (server → worker) are serialized core camelCase →
 *     snake_case by the `to…Wire` mappers. The §2 session-create response uses
 *     `toSessionCreateResponseWire` (session-create-wire.ts) — the `{ session_id, ws_url }`
 *     body — so that one golden-pinned mapper stays the single owner of that shape.
 *
 * The scoped per-environment work-poll token rides the §1 register RESPONSE
 * ({@link EnvironmentRegisterResponseWire.work_poll_token}) even though core's
 * {@link EnvironmentRegisterResponse} models only the environment id: token
 * PROVISIONING is "the transport's concern, out of the core face's scope", so the
 * server mints it and hands it back here. It is a scoped credential (its leak
 * compromises one environment's work queue, not the account), so — unlike the
 * account Bearer — it legitimately travels on the wire.
 */

import {
  isPermissionMode,
  type EnvironmentRegisterRequestBody,
  type SessionCreateRequestBody,
  type WorkItem,
} from "@ccctl/core";

// --- §1 environment register ---

/**
 * The snake_case `POST /v1/environments/bridge` request body — the machine /
 * directory / branch / repository the environment bridges, plus its concurrent
 * session cap. Maps to core's camelCase {@link EnvironmentRegisterRequestBody}.
 */
export interface EnvironmentRegisterRequestWire {
  readonly machine_id: string;
  readonly directory: string;
  readonly branch: string;
  readonly repository: string;
  readonly max_sessions: number;
}

/**
 * The snake_case `POST /v1/environments/bridge` response body: the server-assigned
 * environment id plus the scoped per-environment token the worker presents on the
 * work-poll leg (§3). `work_poll_token` has no core counterpart by design (token
 * provisioning is the transport's concern) — it is minted server-side.
 */
export interface EnvironmentRegisterResponseWire {
  readonly environment_id: string;
  readonly work_poll_token: string;
}

/**
 * Parse a decoded `POST /v1/environments/bridge` body (snake_case) into core's
 * {@link EnvironmentRegisterRequestBody}, or `null` when it is not a well-formed
 * one. Fail-closed over arbitrary bytes: a non-object, a missing/mistyped string
 * field, or a `max_sessions` that is not a positive integer all yield `null`.
 */
export function parseEnvironmentRegisterBody(value: unknown): EnvironmentRegisterRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { machine_id, directory, branch, repository, max_sessions } = value as Record<string, unknown>;
  if (
    typeof machine_id !== "string" ||
    typeof directory !== "string" ||
    typeof branch !== "string" ||
    typeof repository !== "string" ||
    !isPositiveInteger(max_sessions)
  ) {
    return null;
  }
  return { machineId: machine_id, directory, branch, repository, maxSessions: max_sessions };
}

/** Serialize a minted environment id + scoped token into the §1 snake_case response body. */
export function toEnvironmentRegisterResponseWire(
  environmentId: string,
  workPollToken: string,
): EnvironmentRegisterResponseWire {
  return { environment_id: environmentId, work_poll_token: workPollToken };
}

// --- §2 session create ---

/**
 * The snake_case `POST /v1/sessions` request body — the session context (model +
 * cwd), the source that initiated it, and the permission mode. Maps to core's
 * camelCase {@link SessionCreateRequestBody} (`permission_mode` → `permissionMode`).
 */
export interface SessionCreateRequestWire {
  readonly context: { readonly model: string; readonly cwd: string };
  readonly source: string;
  readonly permission_mode: string;
}

/**
 * Parse a decoded `POST /v1/sessions` body (snake_case) into core's
 * {@link SessionCreateRequestBody}, or `null` when it is not a well-formed one.
 * Fail-closed: a non-object, a missing/mistyped `context.model` / `context.cwd` /
 * `source`, or a `permission_mode` that is not one of the pinned
 * {@link isPermissionMode} values (drift) all yield `null`.
 */
export function parseSessionCreateBody(value: unknown): SessionCreateRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { context, source, permission_mode } = value as Record<string, unknown>;
  if (typeof source !== "string" || source === "" || !isPermissionMode(permission_mode)) {
    return null;
  }
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return null;
  }
  const { model, cwd } = context as Record<string, unknown>;
  if (typeof model !== "string" || model === "" || typeof cwd !== "string" || cwd === "") {
    return null;
  }
  return { context: { model, cwd }, source, permissionMode: permission_mode };
}

// --- §3 work poll delivery ---

/**
 * The snake_case `GET …/work/poll` response body — the batch of {@link WorkItem}s
 * delivered to the worker (empty when a long-poll times out with nothing queued).
 * A {@link WorkItem}'s fields (`kind` / `id` / `payload`) are already lowercase and
 * JSON-safe, so no per-field case mapping is needed — the batch is the wire shape.
 */
export interface WorkPollResponseWire {
  readonly work: readonly WorkItem[];
}

/** Serialize a batch of work items into the §3 work-poll response body. */
export function toWorkPollResponseWire(work: readonly WorkItem[]): WorkPollResponseWire {
  return { work };
}

/** A positive integer (a valid concurrent-session cap) — anything else fails closed. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
