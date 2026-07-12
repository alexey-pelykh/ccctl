// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The bridge-protocol wire-conformance oracle — the environments-bridge flow's
 * contract FACE, stated INDEPENDENTLY here and checked against the REAL
 * {@link CcctlServer}, conformed to the current worker's observed wire (issue #131).
 *
 * The point: a green hermetic run must imply INTEROPERABILITY, not merely internal
 * consistency. So the expected snake_case wire shapes below are PINNED independently
 * of the server's own serializers — every path, key set, and the work-secret's
 * structure is hard-stated HERE and asserted against the live server's bytes. A
 * conformance check that derived its expectation from the server's own mapper would
 * move WITH a server-side rename and sail straight through the very drift it exists
 * to catch. This is why nothing here imports the server's wire types or core's
 * work-item guard: the oracle re-derives the worker's view of the wire from scratch,
 * so a server drift off the observed contract fails closed.
 *
 * Two kinds of thing live here:
 *
 *   - PURE per-leg wire-shape assertions — {@link assertEnvironmentRegisterResponseWire}
 *     (§1, `{ environment_id }`), {@link assertSessionCreateResponseWire} (§2,
 *     `{ session_id }`, NO `ws_url`), {@link assertWorkItemWire} (§3, a SINGLE
 *     `{ id, secret, data }` item whose `secret` decodes to a well-formed work-secret):
 *     a string in, a typed verdict out, each unit-testable against a wrong shape.
 *   - The mock bridge's DRIVING helpers — {@link registerEnvironment} (§1),
 *     {@link createSession} (§2), {@link pollWork} (§3): they speak the observed flow
 *     against a real server, feeding each live response through the pure assertions.
 *     {@link assertServerSpeaksBridgeContract} composes them end-to-end and additionally
 *     probes the account-Bearer boundary (§1/§2 require it) and the §4/§5 channel
 *     handshake (`worker/register` + the `PUT worker` status gate).
 *
 * Two-credential boundary (issue #130), pinned here too: the account Bearer rides
 * §1/§2 ONLY; the §3 poll carries NO credential; the §4/§5 channel is authorized by
 * the per-session ingress token minted INTO the work-secret — decoded and shape-checked
 * here — never the account Bearer.
 */

import { ENVIRONMENTS_BRIDGE_PATH, environmentWorkPollPath, formatAuthority, SESSIONS_PATH } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";

/**
 * The snake_case §1 `POST /v1/environments/bridge` response face: the server-assigned
 * environment id. Pinned INDEPENDENTLY of the server's serializer (see the module note);
 * there is NO work-poll token (issue #130), so a resurrected one fails closed here.
 */
export interface EnvironmentRegisterResponseWire {
  readonly environment_id: string;
}

/**
 * The snake_case §2 `POST /v1/sessions` response face — the newly-created session id
 * and NOTHING else. There is NO `ws_url` (the SSE control path never reads one, #130);
 * a `ws_url` emission fails closed here.
 */
export interface SessionCreateResponseWire {
  readonly session_id: string;
}

/**
 * The snake_case §3 work-poll response face — a SINGLE work item
 * (`{ id, secret, data: { type, id? } }`), NOT a `{ work: [...] }` envelope (#130).
 * `secret` is `base64url(JSON(WorkSecret))`, decoded and asserted separately.
 */
export interface WorkItemWire {
  readonly id: string;
  readonly secret: string;
  readonly data: { readonly type: string; readonly id?: string };
}

/**
 * The decoded {@link WorkItemWire.secret} — pinned INDEPENDENTLY here (own base64url +
 * JSON decode, not core's guard): both inner fields are load-bearing (the worker fails
 * the item without either). `session_ingress_token` is the per-session credential the
 * worker presents on §4/§5; `api_base_url` is the base of the child control URL.
 */
export interface DecodedWorkSecret {
  readonly version: number;
  readonly session_ingress_token: string;
  readonly api_base_url: string;
}

/** The pinned §1 response key set AND order — an exact-match target for the live body. */
const ENV_REGISTER_WIRE_KEYS: readonly string[] = ["environment_id"];

/** The pinned §2 response key set AND order. */
const SESSION_CREATE_WIRE_KEYS: readonly string[] = ["session_id"];

/** The pinned §3 single-item key set AND order. */
const WORK_ITEM_WIRE_KEYS: readonly string[] = ["id", "secret", "data"];

/**
 * The account-Bearer-authorized §1 request body the mock bridge sends (observed
 * snake_case wire, #130). Exported as the SINGLE source of the bridge's §1 request wire —
 * the live-worker oracle (`live-worker-oracle.ts`, #133) reuses it so the hermetic golden
 * and the credentialed oracle drive an identical §1 body, never two that can drift apart.
 */
export const BRIDGE_ENVIRONMENT_REGISTER_BODY = {
  machine_name: "e2e-machine",
  directory: "/e2e/proj",
  branch: "main",
  git_repo_url: null,
  max_sessions: 4,
  metadata: { worker_type: "claude_code" },
} as const;

/**
 * The account-Bearer-authorized §2 request body the mock bridge sends (snake_case wire).
 * Exported as the SINGLE source of the §2 request wire — shared with the live-worker
 * oracle (#133) so the hermetic and credentialed drivers never diverge on the §2 body.
 */
export const BRIDGE_SESSION_CREATE_BODY = {
  context: { model: "claude-opus-4-8", cwd: "/e2e/proj" },
  source: "e2e",
  permission_mode: "default",
} as const;

/** How long a conformance HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Assert a §1 environment-register response body IS the pinned `{ environment_id }`
 * wire (exact snake_case key set, non-empty string value) and return it typed. Fails
 * closed — a camelCase leak, a renamed / reordered / missing / extra key (e.g. a
 * resurrected `work_poll_token`), or a non-string value throws rather than passing green.
 */
export function assertEnvironmentRegisterResponseWire(body: string): EnvironmentRegisterResponseWire {
  const record = parseJsonObject(body, "environment-register");
  assertExactKeys(record, ENV_REGISTER_WIRE_KEYS, "environment-register");
  return { environment_id: requireStringField(record, "environment_id", "environment-register") };
}

/**
 * Assert a §2 session-create response body IS the pinned `{ session_id }` wire (exact
 * snake_case key set, non-empty string value — ADR-001, #130) and return it typed. A
 * camelCase `sessionId` leak, any extra key, or a RESURRECTED `ws_url` fails closed —
 * the SSE control path never reads a `ws_url`.
 */
export function assertSessionCreateResponseWire(body: string): SessionCreateResponseWire {
  const record = parseJsonObject(body, "session-create");
  assertExactKeys(record, SESSION_CREATE_WIRE_KEYS, "session-create");
  return { session_id: requireStringField(record, "session_id", "session-create") };
}

/**
 * Assert a §3 work-poll response body IS a SINGLE work item `{ id, secret, data }`
 * (NOT a `{ work: [...] }` envelope, #130), with a `data.type` in the observed set and
 * a `data.id` when `type === "session"`, and return it typed alongside its DECODED
 * work-secret. The secret is decoded here (own base64url + JSON) and asserted to carry
 * BOTH `session_ingress_token` and `api_base_url`. A `{ work: [...] }` envelope, a
 * missing/blank `secret`, or a secret missing either inner field each throws.
 */
export function assertWorkItemWire(body: string): { readonly item: WorkItemWire; readonly secret: DecodedWorkSecret } {
  const record = parseJsonObject(body, "work-poll");
  // The defining regression: the observed poll returns a single item, never the
  // superseded `{ work: [...] }` batch envelope.
  if ("work" in record) {
    throw new Error("ccctl e2e: work-poll returned a { work: [...] } envelope, expected a single item (#130)");
  }
  assertExactKeys(record, WORK_ITEM_WIRE_KEYS, "work-poll");
  const id = requireStringField(record, "id", "work-poll");
  const secret = requireStringField(record, "secret", "work-poll");
  const data = record.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("ccctl e2e: work-poll item `data` is not an object");
  }
  const dataRecord = data as Record<string, unknown>;
  const type = dataRecord.type;
  if (type !== "session" && type !== "healthcheck") {
    throw new Error(`ccctl e2e: work-poll item data.type ${JSON.stringify(type)} is not one of session|healthcheck`);
  }
  const item: WorkItemWire =
    type === "session"
      ? { id, secret, data: { type, id: requireStringField(dataRecord, "id", "work-poll.data") } }
      : { id, secret, data: { type } };
  return { item, secret: decodeWorkSecret(secret) };
}

/** A registered environment: its server-assigned id (no work-poll token, #130). */
export interface RegisteredEnvironment {
  readonly environmentId: string;
}

/** A created session: its server-assigned id (no ws_url, #130). */
export interface CreatedSession {
  readonly sessionId: string;
}

/** A delivered §3 work item: the pinned wire item plus its decoded work-secret. */
export interface DeliveredWork {
  readonly item: WorkItemWire;
  readonly secret: DecodedWorkSecret;
}

/**
 * §1 — register the environment (`POST /v1/environments/bridge`, account Bearer, the
 * observed `machine_name` / nullable `git_repo_url` / `metadata` body). Asserts the
 * `201` and the pinned `{ environment_id }` wire, then returns the environment id the
 * §3 poll path interpolates.
 */
export async function registerEnvironment(server: CcctlServer, bearer: string): Promise<RegisteredEnvironment> {
  const res = await postJson(bridgeUrl(server, ENVIRONMENTS_BRIDGE_PATH), bearer, BRIDGE_ENVIRONMENT_REGISTER_BODY);
  if (res.status !== 201) {
    throw new Error(`ccctl e2e: environment register expected 201 from the local server, got ${res.status}`);
  }
  const wire = assertEnvironmentRegisterResponseWire(await res.text());
  return { environmentId: wire.environment_id };
}

/**
 * §2 — create a session (`POST /v1/sessions`, account Bearer). Asserts the `201` and
 * the pinned `{ session_id }` wire (NO `ws_url`, #130); returns the session id. The
 * server AUTO-ENQUEUES this session's `session` work item, which §3 then delivers.
 */
export async function createSession(server: CcctlServer, bearer: string): Promise<CreatedSession> {
  const res = await postJson(bridgeUrl(server, SESSIONS_PATH), bearer, BRIDGE_SESSION_CREATE_BODY);
  if (res.status !== 201) {
    throw new Error(`ccctl e2e: session create expected 201 from the local server, got ${res.status}`);
  }
  const wire = assertSessionCreateResponseWire(await res.text());
  return { sessionId: wire.session_id };
}

/**
 * §3 — poll for work (`GET /v1/environments/{env}/work/poll`, carrying NO credential,
 * #130). Asserts the `200` and the pinned SINGLE-item wire (with its decoded
 * work-secret) and returns it. Poll AFTER a session-create so the auto-enqueued item is
 * delivered immediately (a non-empty queue answers at once, without the long-poll hold).
 */
export async function pollWork(server: CcctlServer, environmentId: string): Promise<DeliveredWork> {
  const res = await getRequest(bridgeUrl(server, environmentWorkPollPath(environmentId)));
  if (res.status !== 200) {
    throw new Error(`ccctl e2e: work poll expected 200 from the local server, got ${res.status}`);
  }
  return assertWorkItemWire(await res.text());
}

/**
 * Drive the WHOLE observed environments-bridge contract face against a REAL
 * {@link CcctlServer} and assert conformance end-to-end. A green run implies
 * interoperability: the server speaks the observed `register → session-create →
 * work-poll` face, mints a decodable work-secret, enforces the account-Bearer boundary
 * on §1/§2, serves the §3 poll UNCREDENTIALED, and stands up the §4/§5 channel
 * handshake — so the mock bridge is talking to the transport a real worker uses.
 *
 * Checks, all grounded in the live server's own responses / state:
 *
 *   - §1 register — `201` + `{ environment_id }`; and, WITHOUT the account Bearer, `401`.
 *   - §2 session create — `201` + `{ session_id }` (no ws_url); and, WITHOUT the account
 *     Bearer, `401`.
 *   - §3 work poll — UNCREDENTIALED, a single item whose `secret` decodes with both inner
 *     fields, `data` naming the created session.
 *   - §4/§5 — `worker/register` → `{ worker_epoch }`; the `PUT worker` status gate `200`s
 *     on `idle`.
 *
 * Throws on the first breach (a specific message), so a passing call is a positive
 * conformance verdict, never a vacuous one.
 */
export async function assertServerSpeaksBridgeContract(server: CcctlServer, bearer: string): Promise<void> {
  // §1 — register the environment; and the account-Bearer boundary (missing → 401).
  const { environmentId } = await registerEnvironment(server, bearer);
  const envNoBearer = await postJson(
    bridgeUrl(server, ENVIRONMENTS_BRIDGE_PATH),
    null,
    BRIDGE_ENVIRONMENT_REGISTER_BODY,
  );
  if (envNoBearer.status !== 401) {
    throw new Error(`ccctl e2e: §1 register without the account Bearer expected 401, got ${envNoBearer.status}`);
  }

  // §2 — create a session; and its account-Bearer boundary (missing → 401).
  const { sessionId } = await createSession(server, bearer);
  const sessionNoBearer = await postJson(bridgeUrl(server, SESSIONS_PATH), null, BRIDGE_SESSION_CREATE_BODY);
  if (sessionNoBearer.status !== 401) {
    throw new Error(
      `ccctl e2e: §2 session create without the account Bearer expected 401, got ${sessionNoBearer.status}`,
    );
  }

  // §3 — the poll is UNCREDENTIALED and delivers the auto-enqueued single item for THIS
  // session, whose secret decodes with both inner fields.
  const { item } = await pollWork(server, environmentId);
  if (item.data.type !== "session" || item.data.id !== sessionId) {
    throw new Error(`ccctl e2e: §3 poll did not deliver the session-dispatch item for ${sessionId}`);
  }

  // §4/§5 — the channel handshake: register mints a worker_epoch; the PUT status gate 200s on idle.
  const epoch = await assertWorkerRegister(server, sessionId);
  const status = await putWorkerStatus(server, sessionId, epoch, "idle");
  if (status.status !== 200) {
    throw new Error(`ccctl e2e: §4 PUT worker status idle expected 200, got ${status.status}`);
  }
}

// --- §4/§5 channel handshake (paths pinned INDEPENDENTLY, not imported from core) ---

/** The observed §4/§5 channel root for a session — pinned here, not imported (#130). */
export function workerChannelBase(sessionId: string): string {
  return `/v1/code/sessions/${sessionId}/worker`;
}

/** §4 — `POST worker/register` `{}` and assert `{ worker_epoch }`; returns the epoch. */
export async function assertWorkerRegister(server: CcctlServer, sessionId: string): Promise<number> {
  const res = await fetch(bridgeUrl(server, `${workerChannelBase(sessionId)}/register`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`ccctl e2e: §4 worker/register expected 200, got ${res.status}`);
  }
  const record = parseJsonObject(await res.text(), "worker-register");
  const epoch = record.worker_epoch;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch <= 0) {
    throw new Error("ccctl e2e: §4 worker/register response is missing a positive integer worker_epoch");
  }
  return epoch;
}

/** §4 — `PUT worker` status gate carrying the epoch. */
export function putWorkerStatus(
  server: CcctlServer,
  sessionId: string,
  epoch: number,
  status: string,
): Promise<Response> {
  return fetch(bridgeUrl(server, workerChannelBase(sessionId)), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_status: status, worker_epoch: epoch, external_metadata: {} }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// --- decode + shape helpers ---

/**
 * Decode a base64url(JSON(WorkSecret)) `secret` and assert its shape INDEPENDENTLY —
 * `version` a number, and BOTH `session_ingress_token` and `api_base_url` non-empty
 * strings (both load-bearing, #130). Not core's guard: the oracle re-derives the
 * worker's view so a server-side drift in the secret shape fails closed here.
 */
export function decodeWorkSecret(secret: string): DecodedWorkSecret {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(secret, "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("ccctl e2e: work-item secret is not base64url(JSON)", { cause });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("ccctl e2e: decoded work-secret is not a JSON object");
  }
  const record = decoded as Record<string, unknown>;
  if (typeof record.version !== "number") {
    throw new Error("ccctl e2e: work-secret `version` must be a number");
  }
  return {
    version: record.version,
    session_ingress_token: requireStringField(record, "session_ingress_token", "work-secret"),
    api_base_url: requireStringField(record, "api_base_url", "work-secret"),
  };
}

/** The `http://host:port` base for a request at `path` against a running server. */
function bridgeUrl(server: CcctlServer, path: string): string {
  return `http://${formatAuthority(server.address.host, server.address.port)}${path}`;
}

/**
 * Assert a parsed object's key set IS exactly `keys`, in order — a re-guessed shape
 * (wrong casing, reordered / missing / extra key) fails closed rather than agreeing with
 * a wrong contract. The shape gate shared by every pinned response face.
 */
function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], leg: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(
      `ccctl e2e: ${leg} response wire shape ${JSON.stringify(actual)} does not match the pinned contract ${JSON.stringify(keys)}`,
    );
  }
}

/** Read `record[key]` as a non-empty string (narrowed), or throw a leg-tagged fail-closed error. */
function requireStringField(record: Record<string, unknown>, key: string, leg: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`ccctl e2e: ${leg} wire field \`${key}\` must be a non-empty string`);
  }
  return value;
}

/** Parse a wire body into a plain JSON object, or throw a leg-tagged fail-closed error. */
function parseJsonObject(body: string, leg: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(`ccctl e2e: ${leg} response body is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`ccctl e2e: ${leg} response body is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** POST a JSON body, optionally carrying `Authorization: Bearer {bearer}` (omitted when null). */
function postJson(url: string, bearer: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== null) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** GET carrying NO credential — the §3 poll is uncredentialed (#130). */
function getRequest(url: string): Promise<Response> {
  return fetch(url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
