// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The bridge-protocol wire-conformance oracle — the current environments-bridge
 * flow's contract FACE, stated INDEPENDENTLY here and checked against the REAL
 * {@link CcctlServer}.
 *
 * The point (#124 AC-2): a green hermetic run must imply INTEROPERABILITY, not
 * merely internal consistency. So the expected snake_case wire shapes below are
 * PINNED independently of the server's own serializers. A conformance check that
 * derived its expectation from the server's own mapper would move WITH a
 * server-side rename and sail straight through the very drift it exists to catch;
 * pinning the shapes HERE and asserting the live server's bytes against them is
 * what makes this an interoperability oracle — if `@ccctl/server` drifts off the
 * current contract face, the mock bridge and this assertion fail closed.
 *
 * Two kinds of thing live here:
 *
 *   - PURE per-leg wire-shape assertions — {@link assertEnvironmentRegisterResponseWire}
 *     (§1), {@link assertSessionCreateResponseWire} (§2),
 *     {@link assertWorkPollResponseWire} (§3): a string in, a typed verdict out, so
 *     each is unit-testable in isolation against a wrong shape (a camelCase leak, a
 *     reordered/missing/extra key, a drifted work item).
 *   - The mock bridge's DRIVING helpers — {@link registerEnvironment} (§1),
 *     {@link createSession} (§2), {@link pollWork} / {@link ackWork} (§3, which
 *     {@link roundTripWork} composes into the one enqueue→poll→ack round-trip the oracle
 *     and the one-session harness share): they speak the current flow against a real
 *     server, feeding each live response through the pure assertions. Both
 *     `traffic-harness` and `one-session-harness` drive the
 *     current flow through these, so the harness has ONE statement of the wire
 *     contract. {@link assertServerSpeaksBridgeContract} composes them end-to-end and
 *     additionally exercises the two-token credential boundary — the defining feature
 *     of the current flow versus the superseded single-step register.
 *
 * The §3 work-item shape is NOT re-pinned here: it is validated through core's own
 * fail-closed {@link workItemFromValue} guard — the shared contract both the server
 * and a real worker honor — so a drifted work item fails closed exactly as it would
 * on a real worker.
 */

import {
  ENVIRONMENTS_BRIDGE_PATH,
  environmentWorkPollPath,
  formatAuthority,
  SESSIONS_PATH,
  workAckPath,
  workItemFromValue,
  type WorkItem,
} from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";

/**
 * The snake_case §1 `POST /v1/environments/bridge` response face: the server-assigned
 * environment id plus the scoped per-environment work-poll token. Pinned INDEPENDENTLY
 * of the server's serializer (see the module note) so a server rename fails closed here.
 */
export interface EnvironmentRegisterResponseWire {
  readonly environment_id: string;
  readonly work_poll_token: string;
}

/**
 * The snake_case §2 `POST /v1/sessions` response face — the newly-created session id
 * and the `ws_url` the per-session worker channel (§4) opens to. The same
 * `{ session_id, ws_url }` body the golden-pinned register seam (ADR-001) owns
 * server-side; pinned here independently as the interoperability oracle.
 */
export interface SessionCreateResponseWire {
  readonly session_id: string;
  readonly ws_url: string;
}

/** The pinned §1 response key set AND order — an exact-match target for the live body. */
const ENV_REGISTER_WIRE_KEYS: readonly string[] = ["environment_id", "work_poll_token"];

/** The pinned §2 response key set AND order (ADR-001). */
const SESSION_CREATE_WIRE_KEYS: readonly string[] = ["session_id", "ws_url"];

/** The pinned §3 work-poll response envelope key set. */
const WORK_POLL_WIRE_KEYS: readonly string[] = ["work"];

/** The account-Bearer-authorized §1 request body the mock bridge sends (snake_case wire). */
const MOCK_ENVIRONMENT_REGISTER_BODY = {
  machine_id: "e2e-machine",
  directory: "/e2e/proj",
  branch: "main",
  repository: "ccctl/e2e",
  max_sessions: 4,
} as const;

/** The account-Bearer-authorized §2 request body the mock bridge sends (snake_case wire). */
const MOCK_SESSION_CREATE_BODY = {
  context: { model: "claude-opus-4-8", cwd: "/e2e/proj" },
  source: "e2e",
  permission_mode: "default",
} as const;

/** How long a conformance HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Assert a §1 environment-register response body IS the pinned
 * `{ environment_id, work_poll_token }` wire (exact snake_case key set, order, and
 * non-empty string values) and return it typed. Fails closed — a camelCase leak, a
 * renamed / reordered / missing / extra key, or a non-string value throws rather than
 * passing green.
 */
export function assertEnvironmentRegisterResponseWire(body: string): EnvironmentRegisterResponseWire {
  const record = parseJsonObject(body, "environment-register");
  assertExactKeys(record, ENV_REGISTER_WIRE_KEYS, "environment-register");
  return {
    environment_id: requireStringField(record, "environment_id", "environment-register"),
    work_poll_token: requireStringField(record, "work_poll_token", "environment-register"),
  };
}

/**
 * Assert a §2 session-create response body IS the pinned `{ session_id, ws_url }` wire
 * (exact snake_case key set, order, and non-empty string values — ADR-001) and return
 * it typed. The register→worker contract FACE a worker parses; a camelCase
 * `sessionId`/`wsUrl` leak or any re-guessed shape fails closed.
 */
export function assertSessionCreateResponseWire(body: string): SessionCreateResponseWire {
  const record = parseJsonObject(body, "session-create");
  assertExactKeys(record, SESSION_CREATE_WIRE_KEYS, "session-create");
  return {
    session_id: requireStringField(record, "session_id", "session-create"),
    ws_url: requireStringField(record, "ws_url", "session-create"),
  };
}

/**
 * Assert a §3 work-poll response body IS the pinned `{ work: WorkItem[] }` envelope and
 * return the items typed. `work` must be an array, and EVERY element must pass core's
 * fail-closed {@link workItemFromValue} — a drifted item (unknown `kind`, missing `id`,
 * malformed `payload`) throws, so a poll body a real worker could not dispatch never
 * passes green here either.
 */
export function assertWorkPollResponseWire(body: string): WorkItem[] {
  const parsed = parseJsonObject(body, "work-poll");
  assertExactKeys(parsed, WORK_POLL_WIRE_KEYS, "work-poll");
  const work = parsed.work;
  if (!Array.isArray(work)) {
    throw new Error("ccctl e2e: work-poll response `work` field is not an array");
  }
  return work.map((value, index) => {
    const item = workItemFromValue(value);
    if (item === null) {
      throw new Error(`ccctl e2e: work-poll response item ${index} is not a well-formed WorkItem (drift)`);
    }
    return item;
  });
}

/** A registered environment: its server-assigned id and its scoped §3 work-poll token. */
export interface RegisteredEnvironment {
  readonly environmentId: string;
  readonly workPollToken: string;
}

/** A created session: its server-assigned id and the `ws_url` the §4 worker channel opens to. */
export interface CreatedSession {
  readonly sessionId: string;
  readonly wsUrl: string;
}

/**
 * §1 — register the environment (`POST /v1/environments/bridge`, account Bearer). Asserts
 * the `201` and the pinned `{ environment_id, work_poll_token }` wire, then returns the
 * environment id + scoped work-poll token the §3 leg presents.
 */
export async function registerEnvironment(server: CcctlServer, bearer: string): Promise<RegisteredEnvironment> {
  const res = await postJson(bridgeUrl(server, ENVIRONMENTS_BRIDGE_PATH), bearer, MOCK_ENVIRONMENT_REGISTER_BODY);
  if (res.status !== 201) {
    throw new Error(`ccctl e2e: environment register expected 201 from the local server, got ${res.status}`);
  }
  const wire = assertEnvironmentRegisterResponseWire(await res.text());
  return { environmentId: wire.environment_id, workPollToken: wire.work_poll_token };
}

/**
 * §2 — create a session (`POST /v1/sessions`, account Bearer). Asserts the `201`, the
 * pinned `{ session_id, ws_url }` wire (ADR-001), and that `ws_url` points at THIS
 * server's per-session worker channel (`ws://authority/v1/sessions/{id}/ws`); returns
 * the session id + `ws_url`.
 */
export async function createSession(server: CcctlServer, bearer: string): Promise<CreatedSession> {
  const res = await postJson(bridgeUrl(server, SESSIONS_PATH), bearer, MOCK_SESSION_CREATE_BODY);
  if (res.status !== 201) {
    throw new Error(`ccctl e2e: session create expected 201 from the local server, got ${res.status}`);
  }
  const wire = assertSessionCreateResponseWire(await res.text());
  const authority = formatAuthority(server.address.host, server.address.port);
  const expectedWsUrl = `ws://${authority}${SESSIONS_PATH}/${wire.session_id}/ws`;
  if (wire.ws_url !== expectedWsUrl) {
    throw new Error(
      `ccctl e2e: session-create ws_url ${wire.ws_url} does not point at this server's worker channel (${expectedWsUrl})`,
    );
  }
  return { sessionId: wire.session_id, wsUrl: wire.ws_url };
}

/**
 * §3 — poll for work (`GET /v1/environments/{env}/work/poll`, SCOPED per-environment
 * token). Asserts the `200` and the pinned `{ work: WorkItem[] }` wire (each item through
 * core's fail-closed guard) and returns the delivered batch. Enqueue work BEFORE polling
 * for a deterministic immediate delivery (the server answers a non-empty queue at once,
 * without the long-poll hold).
 */
export async function pollWork(server: CcctlServer, environmentId: string, token: string): Promise<WorkItem[]> {
  const res = await getRequest(bridgeUrl(server, environmentWorkPollPath(environmentId)), token);
  if (res.status !== 200) {
    throw new Error(`ccctl e2e: work poll expected 200 from the local server, got ${res.status}`);
  }
  return assertWorkPollResponseWire(await res.text());
}

/**
 * §3 — ack one delivered work item (`POST /v1/environments/{env}/work/{id}/ack`, SCOPED
 * token). Asserts the `204` — the server dropping the in-flight item is the receiver's
 * own record that the ack leg round-tripped.
 */
export async function ackWork(
  server: CcctlServer,
  environmentId: string,
  workId: string,
  token: string,
): Promise<void> {
  const res = await postJson(bridgeUrl(server, workAckPath(environmentId, workId)), token, {});
  if (res.status !== 204) {
    throw new Error(`ccctl e2e: work ack expected 204 from the local server, got ${res.status}`);
  }
}

/**
 * §3 — drive the enqueue→poll→ack round-trip for ONE work item and return it as the
 * server delivered it. Enqueues `item` for `environmentId`, polls it back under the
 * SCOPED `token`, asserts it round-trips intact (an item with the same `id` AND `kind`
 * comes back), then acks it. Fails closed — an unknown environment, a poll that does
 * not return the item, or a kind mismatch throws (a specific message) rather than
 * passing green. Both {@link assertServerSpeaksBridgeContract} and the one-session
 * harness drive §3 through this, so the round-trip is stated ONCE.
 */
export async function roundTripWork(
  server: CcctlServer,
  environmentId: string,
  token: string,
  item: WorkItem,
): Promise<WorkItem> {
  if (!server.enqueueWork(environmentId, item)) {
    throw new Error(`ccctl e2e: could not enqueue work item ${item.id} (unknown environment ${environmentId})`);
  }
  const delivered = await pollWork(server, environmentId, token);
  const received = delivered.find((candidate) => candidate.id === item.id);
  if (received === undefined || received.kind !== item.kind) {
    throw new Error(
      `ccctl e2e: §3 work poll did not round-trip the enqueued item (expected kind ${item.kind} id ${item.id}, got ${JSON.stringify(delivered)})`,
    );
  }
  await ackWork(server, environmentId, item.id, token);
  return received;
}

/**
 * Drive the WHOLE current environments-bridge contract face against a REAL
 * {@link CcctlServer} and assert conformance end-to-end — the AC-2 wire-conformance
 * assertion (#124). A green run implies interoperability: the server speaks the current
 * `register → session-create → work-poll` face AND enforces the two-token credential
 * boundary, so the mock bridge is talking to the transport a real worker uses, not a
 * stale one.
 *
 * Checks, all grounded in the live server's own responses / state:
 *
 *   - §1 register — `201` + pinned `{ environment_id, work_poll_token }`; and, WITHOUT the
 *     account Bearer, `401` (§1 is account-Bearer-authorized).
 *   - §2 session create — `201` + pinned `{ session_id, ws_url }` pointing at this server;
 *     and, WITHOUT the account Bearer, `401`.
 *   - §3 work poll — a queued item is delivered under the SCOPED token as the pinned
 *     `{ work: [...] }` batch and round-trips (kind + id preserved), then acks (`204`);
 *     and, presented the ACCOUNT Bearer instead of the scoped token, the poll fails closed
 *     `401` — the two-token boundary that distinguishes the current flow from the
 *     superseded single-step register.
 *
 * Throws on the first breach (a specific message), so a passing call is a positive
 * conformance verdict, never a vacuous one.
 */
export async function assertServerSpeaksBridgeContract(server: CcctlServer, bearer: string): Promise<void> {
  // §1 — register the environment; and the account-Bearer boundary (missing → 401).
  const { environmentId, workPollToken } = await registerEnvironment(server, bearer);
  const envNoBearer = await postJson(bridgeUrl(server, ENVIRONMENTS_BRIDGE_PATH), null, MOCK_ENVIRONMENT_REGISTER_BODY);
  if (envNoBearer.status !== 401) {
    throw new Error(
      `ccctl e2e: §1 environment register without the account Bearer expected 401, got ${envNoBearer.status}`,
    );
  }

  // §2 — create a session; and its account-Bearer boundary (missing → 401).
  const { sessionId } = await createSession(server, bearer);
  const sessionNoBearer = await postJson(bridgeUrl(server, SESSIONS_PATH), null, MOCK_SESSION_CREATE_BODY);
  if (sessionNoBearer.status !== 401) {
    throw new Error(
      `ccctl e2e: §2 session create without the account Bearer expected 401, got ${sessionNoBearer.status}`,
    );
  }

  // §3 — the two-token boundary: the ACCOUNT Bearer must NOT open the work-poll leg.
  const pollWithAccountBearer = await getRequest(bridgeUrl(server, environmentWorkPollPath(environmentId)), bearer);
  if (pollWithAccountBearer.status !== 401) {
    throw new Error(
      `ccctl e2e: §3 work poll presented the account Bearer (not the scoped token) expected 401, got ${pollWithAccountBearer.status}`,
    );
  }

  // §3 — the scoped token DOES open it: a queued item is delivered, round-trips, and acks.
  const probe: WorkItem = { kind: "create_session", id: "wire-conformance-probe", payload: { session_id: sessionId } };
  await roundTripWork(server, environmentId, workPollToken, probe);
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
    throw new Error(`ccctl e2e: ${leg} response wire field \`${key}\` must be a non-empty string`);
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

/** GET carrying `Authorization: Bearer {bearer}`. */
function getRequest(url: string, bearer: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
