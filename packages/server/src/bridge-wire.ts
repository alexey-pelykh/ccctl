// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Wire DTOs for the environments-bridge flow — the server HTTP boundary's
 * snake_case seam between `@ccctl/core`'s camelCase model and the bytes on the
 * Claude Code `--sdk-url` control transport (ADR-001's convention, extended from
 * the register response to the whole flow), conformed to the worker's
 * *actually-observed* wire (issue #130).
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
 *     snake_case by the `to…Wire` mappers: the §1 register response
 *     ({@link toEnvironmentRegisterResponseWire}, a bare `{ environment_id }`), the
 *     §2 session-create response (`toSessionCreateResponseWire`, session-create-wire.ts),
 *     and the §3 single work item ({@link toWorkItemWire}).
 *
 * The §3 work-poll answers with a SINGLE {@link WorkItem} object (or an empty body —
 * "no work"), NOT a `{ work: [...] }` envelope: the observed worker polls one item at
 * a time under a reclaim model (`reclaim_older_than_ms`), never acking a batch.
 */

import {
  isPermissionMode,
  type EnvironmentRegisterRequestBody,
  type JsonObject,
  type SessionCreateRequestBody,
  type WorkItem,
} from "@ccctl/core";

// --- §1 environment register ---

/**
 * The snake_case `POST /v1/environments/bridge` request body — the machine name,
 * working directory, branch, git remote URL (nullable), a concurrent-session cap,
 * and an opaque metadata bag. Maps to core's camelCase
 * {@link EnvironmentRegisterRequestBody}.
 */
export interface EnvironmentRegisterRequestWire {
  readonly machine_name: string;
  readonly directory: string;
  readonly branch: string;
  readonly git_repo_url: string | null;
  readonly max_sessions: number;
  readonly metadata: JsonObject;
}

/**
 * The snake_case `POST /v1/environments/bridge` response body: the server-assigned
 * environment id the worker interpolates into the §3 work-poll path. There is no
 * work-poll token — the §3 leg carries no credential (issue #130).
 */
export interface EnvironmentRegisterResponseWire {
  readonly environment_id: string;
}

/**
 * Parse a decoded `POST /v1/environments/bridge` body (snake_case) into core's
 * {@link EnvironmentRegisterRequestBody}, or `null` when it is not a well-formed
 * one. Fail-closed over arbitrary bytes: a non-object, a missing/mistyped string
 * field, a `git_repo_url` that is neither a string nor `null`, a non-object
 * `metadata`, or a `max_sessions` that is not a positive integer all yield `null`.
 */
export function parseEnvironmentRegisterBody(value: unknown): EnvironmentRegisterRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { machine_name, directory, branch, git_repo_url, max_sessions, metadata } = value as Record<string, unknown>;
  if (
    typeof machine_name !== "string" ||
    machine_name === "" ||
    typeof directory !== "string" ||
    typeof branch !== "string" ||
    !isNullableString(git_repo_url) ||
    !isPositiveInteger(max_sessions) ||
    !isJsonObject(metadata)
  ) {
    return null;
  }
  return {
    machineName: machine_name,
    directory,
    branch,
    gitRepoUrl: git_repo_url,
    maxSessions: max_sessions,
    metadata,
  };
}

/** Serialize a minted environment id into the §1 snake_case response body. */
export function toEnvironmentRegisterResponseWire(environmentId: string): EnvironmentRegisterResponseWire {
  return { environment_id: environmentId };
}

// --- §2 session create ---

/**
 * The snake_case `POST /v1/sessions` request body — the session context (model +
 * cwd), the source that initiated it, and the permission mode. Maps to core's
 * camelCase {@link SessionCreateRequestBody} (`permission_mode` → `permissionMode`).
 *
 * The context is carried under **`session_context`** — the field name the observed
 * worker actually sends (issue #154). The worker also carries extra keys the server
 * neither needs nor stores: `sources` / `outcomes` / `reuse_outcome_branches` inside
 * `session_context`, and a top-level `environment_id`. They are accepted and ignored
 * (extra JSON keys are simply not read) — only `model` + `cwd` are load-bearing here.
 */
export interface SessionCreateRequestWire {
  readonly session_context: { readonly model: string; readonly cwd: string };
  readonly source: string;
  readonly permission_mode: string;
}

/**
 * Parse a decoded `POST /v1/sessions` body (snake_case) into core's
 * {@link SessionCreateRequestBody}, or `null` when it is not a well-formed one.
 * Fail-closed: a non-object, a missing/mistyped `session_context.model` /
 * `session_context.cwd` / `source`, or a `permission_mode` that is not one of the
 * pinned {@link isPermissionMode} values (drift) all yield `null`. Extra fields — the
 * worker's `sources` / `outcomes` / `reuse_outcome_branches` (inside `session_context`)
 * and top-level `environment_id` (issue #154) — are ignored, not rejected.
 */
export function parseSessionCreateBody(value: unknown): SessionCreateRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { session_context, source, permission_mode } = value as Record<string, unknown>;
  if (typeof source !== "string" || source === "" || !isPermissionMode(permission_mode)) {
    return null;
  }
  if (typeof session_context !== "object" || session_context === null || Array.isArray(session_context)) {
    return null;
  }
  const { model, cwd } = session_context as Record<string, unknown>;
  if (typeof model !== "string" || model === "" || typeof cwd !== "string" || cwd === "") {
    return null;
  }
  return { context: { model, cwd }, source, permissionMode: permission_mode };
}

// --- §3 work poll delivery ---

/**
 * The snake_case `GET …/work/poll` response body — a SINGLE {@link WorkItem}
 * (`{ id, secret, data: { type, id? } }`). A {@link WorkItem}'s fields are already
 * lowercase/JSON-safe, so no per-field case mapping is needed; the item IS the wire
 * shape. A `healthcheck` item omits `data.id`; a `session` item carries it.
 */
export interface WorkItemWire {
  readonly id: string;
  readonly secret: string;
  readonly data: { readonly type: string; readonly id?: string };
}

/**
 * Serialize a single work item into the §3 work-poll response body. A `session`
 * item carries `data.id` (its session id); a `healthcheck` item omits it. When there
 * is NO work the handler answers an empty body instead of calling this — the wire
 * has no envelope to represent "empty".
 */
export function toWorkItemWire(item: WorkItem): WorkItemWire {
  const data = item.data.id === undefined ? { type: item.data.type } : { type: item.data.type, id: item.data.id };
  return { id: item.id, secret: item.secret, data };
}

// --- shared guards ---

/** A positive integer (a valid concurrent-session cap) — anything else fails closed. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** A string or `null` — the shape of a nullable wire field (`git_repo_url`). */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A plain JSON object (the `metadata` bag) — a non-object / array / null fails closed. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
