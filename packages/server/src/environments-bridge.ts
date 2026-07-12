// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The environments-bridge flow — the server side (bridge-protocol §1/§2/§3).
 *
 * `@ccctl/server` terminates the current Claude Code build's native control
 * transport. This module owns three of its four legs (§4, the per-session worker
 * WebSocket, is `worker-channel.ts`):
 *
 *   §1. **Environment register** — `POST /v1/environments/bridge`
 *       ({@link handleEnvironmentRegister}). The account Bearer authorizes it; the
 *       server mints an environment id and a SCOPED per-environment work-poll token
 *       and hands both back.
 *   §2. **Session create** — `POST /v1/sessions` ({@link handleSessionCreate}). The
 *       account Bearer authorizes it; the server creates a {@link Session}
 *       (`connecting`) and mints the `ws_url` the worker opens its §4 channel to.
 *   §3. **Work delivery** — `GET …/work/poll` ({@link handleWorkPoll}), long-polled
 *       and authorized by the SCOPED token (NEVER the account Bearer), delivering
 *       `create_session` / `resume_session` / `user_turn` / `steer` work items; each
 *       acked ({@link handleWorkAck}) or stopped ({@link handleWorkStop}).
 *       {@link enqueueWork} is the server-side ingress that feeds the queue.
 *
 * **Two-token credential boundary (HARD, bridge-protocol §5 / #60).** The account
 * OAuth Bearer rides §1/§2 (and §4). It is a strict NON-PERSISTING pass-through:
 * validated for RECEIPT via {@link parseBearer}, then dropped — it is never written
 * into an {@link EnvironmentRecord}, a {@link Session}, a response body, or a log
 * (there is no logging here). The work-poll leg (§3) is authorized by the scoped
 * per-environment token INSTEAD — a request presenting the account Bearer on §3
 * fails closed (it is not the environment's token), which is the boundary made
 * structural: only the scoped credential opens the work queue.
 *
 * **Fail closed on drift.** Pinned paths come from `@ccctl/core`
 * ({@link SESSIONS_PATH} et al.); an unknown `permission_mode` (§2) or a malformed
 * body is a `400`, a wrong/absent credential a `401`, an unknown environment a
 * `404` — never a silent accept.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BRIDGE_PROTOCOL_API_VERSION,
  createSession,
  environmentToken,
  formatAuthority,
  SESSIONS_PATH,
  type EnvironmentToken,
  type HostEndpoint,
  type Session,
  type WorkItem,
} from "@ccctl/core";
import { parseBearer } from "./bearer.js";
import { readJsonBody, writeError, writeJson } from "./http-response.js";
import {
  parseEnvironmentRegisterBody,
  parseSessionCreateBody,
  toEnvironmentRegisterResponseWire,
  toWorkPollResponseWire,
} from "./bridge-wire.js";
import { toSessionCreateResponseWire } from "./session-create-wire.js";

/** Hard ceiling on a bridge request body (1 MiB) — a control-plane body fits well within it. */
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024;

/**
 * Default long-poll hold (25 s): how long a `…/work/poll` with an empty queue is
 * held open before it answers with an empty batch, so the worker re-polls promptly
 * without a tight loop. Injectable via {@link BridgeState.workPollTimeoutMs} so a
 * test drives a short, deterministic timeout.
 */
export const DEFAULT_WORK_POLL_TIMEOUT_MS = 25_000;

/** A work-poll response held open until work arrives or the long-poll window lapses. */
interface PollWaiter {
  /**
   * Deliver the environment's queued work to this held poll IF it is still live,
   * draining the queue UNDER the settled guard (so a settled or already-disconnected
   * poll never strands work in in-flight, nor throws a write-after-end out of
   * {@link enqueueWork}). Returns whether it delivered.
   */
  readonly deliverQueued: () => boolean;
  /** Settle the held poll with an empty batch — the long-poll timeout and the shutdown drain. */
  readonly settleEmpty: () => void;
  /** The long-poll timeout timer, cleared when the poll is settled early. */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Server-side record of one bridged environment: its scoped token, cap, and work queue. */
export interface EnvironmentRecord {
  /** Server-assigned environment id (interpolated into the §3 work paths). */
  readonly id: string;
  /** The scoped per-environment work-poll token — the §3 credential, NEVER the account Bearer. */
  readonly workPollToken: EnvironmentToken;
  /** The concurrent-session cap the environment declared at register. */
  readonly maxSessions: number;
  /** Work awaiting delivery, FIFO. */
  readonly queue: WorkItem[];
  /**
   * Work delivered to the worker and awaiting ack/stop, keyed by work id. Delivery
   * is at-most-once at this slice: an item moved here is NOT redelivered or expired,
   * so a worker that dies after delivery but before ack/stop drops it. Redelivery /
   * a visibility timeout is a later item, once real triggers feed the queue.
   */
  readonly inFlight: Map<string, WorkItem>;
  /** Poll responses held open awaiting work (at most one per worker at this slice). */
  readonly waiters: Set<PollWaiter>;
}

/**
 * The per-server state the environments-bridge legs read and update. The overall
 * {@link CcctlServer} state satisfies this structurally, so the handlers stay
 * decoupled from the HTTP wiring in `index.ts`.
 */
export interface BridgeState {
  /** Environments registered on this server, keyed by environment id. */
  readonly environments: Map<string, EnvironmentRecord>;
  /** Sessions tracked by this server, keyed by ccctl session id (session-create adds here). */
  readonly sessions: Map<string, Session>;
  /** The bound address, so §2 can mint a `ws_url` pointing back at this server. */
  readonly address: HostEndpoint;
  /** Long-poll hold before an empty `…/work/poll` answers (ms). */
  readonly workPollTimeoutMs: number;
}

/**
 * Handle `POST /v1/environments/bridge` (§1). Requires the account Bearer (present
 * → validated for receipt, then dropped; never persisted), parses the body
 * fail-closed, mints an environment id + a scoped work-poll token, records the
 * environment, and answers `201` with `{ environment_id, work_poll_token }`.
 */
export function handleEnvironmentRegister(req: IncomingMessage, res: ServerResponse, state: BridgeState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the environment-register path`);
    return;
  }
  // Account Bearer (bridge-protocol §5): required, non-persisting. Parsed to
  // confirm receipt and discarded — it is never stored on the EnvironmentRecord.
  if (parseBearer(req.headers.authorization) === null) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeError(res, 401, "ccctl: missing or malformed `Authorization: Bearer` credential");
    return;
  }
  void readJsonBody(req, MAX_BRIDGE_BODY_BYTES).then((result) => {
    if (!result.ok) {
      writeError(res, result.status, result.message);
      return;
    }
    const body = parseEnvironmentRegisterBody(result.value);
    if (body === null) {
      writeError(res, 400, "ccctl: malformed environment-register body");
      return;
    }
    const id = randomUUID();
    // Scoped per-environment token: high-entropy, minted server-side (provisioning
    // is the transport's concern, out of the core face). Distinct from the account
    // Bearer by construction, so presenting the account Bearer on §3 cannot match.
    const token = environmentToken(randomBytes(24).toString("base64url"));
    state.environments.set(id, {
      id,
      workPollToken: token,
      maxSessions: body.maxSessions,
      queue: [],
      inFlight: new Map<string, WorkItem>(),
      waiters: new Set<PollWaiter>(),
    });
    writeJson(res, 201, toEnvironmentRegisterResponseWire(id, token));
  });
}

/**
 * Handle `POST /v1/sessions` (§2). Requires the account Bearer (non-persisting),
 * parses the body fail-closed (including the pinned `permission_mode`), creates a
 * `connecting` {@link Session}, mints the `ws_url` the worker opens its §4 channel
 * to, and answers `201` with the golden-pinned `{ session_id, ws_url }` wire.
 */
export function handleSessionCreate(req: IncomingMessage, res: ServerResponse, state: BridgeState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${SESSIONS_PATH}`);
    return;
  }
  if (parseBearer(req.headers.authorization) === null) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeError(res, 401, "ccctl: missing or malformed `Authorization: Bearer` credential");
    return;
  }
  void readJsonBody(req, MAX_BRIDGE_BODY_BYTES).then((result) => {
    if (!result.ok) {
      writeError(res, result.status, result.message);
      return;
    }
    const body = parseSessionCreateBody(result.value);
    if (body === null) {
      writeError(res, 400, "ccctl: malformed session-create body (bad context/source/permission_mode)");
      return;
    }
    const sessionId = randomUUID();
    const wsUrl = `ws://${formatAuthority(state.address.host, state.address.port)}${SESSIONS_PATH}/${sessionId}/ws`;
    state.sessions.set(sessionId, createSession(sessionId));
    // Serialize through the golden-pinned wire seam (ADR-001), never the core object
    // directly — the §2 response IS the `{ session_id, ws_url }` body the worker parses.
    writeJson(res, 201, toSessionCreateResponseWire({ sessionId, wsUrl }));
  });
}

/**
 * Handle `GET /v1/environments/{env}/work/poll` (§3). Authorized by the SCOPED
 * per-environment token — the account Bearer does not open this leg. Delivers any
 * queued work immediately; otherwise long-polls, holding the response open until
 * work is enqueued or {@link BridgeState.workPollTimeoutMs} lapses (then an empty
 * batch). Delivered items move to {@link EnvironmentRecord.inFlight} awaiting ack/stop.
 */
export function handleWorkPoll(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  environmentId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the work-poll path`);
    return;
  }
  const env = requireScopedEnvironment(req, res, state, environmentId);
  if (env === null) {
    return;
  }
  if (env.queue.length > 0) {
    writeJson(res, 200, toWorkPollResponseWire(drainQueue(env)));
    return;
  }
  // Nothing queued: hold the response open (long-poll). `finish` is guarded so an
  // enqueue that races the timeout, a client disconnect, and a shutdown drain all
  // resolve the held response exactly once.
  let settled = false;
  const finish = (work: readonly WorkItem[]): void => {
    if (settled) {
      return;
    }
    settled = true;
    env.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    writeJson(res, 200, toWorkPollResponseWire(work));
  };
  const waiter: PollWaiter = {
    deliverQueued: () => {
      if (settled || isResponseClosed(res)) {
        return false;
      }
      finish(drainQueue(env));
      return true;
    },
    settleEmpty: () => {
      finish([]);
    },
    timer: setTimeout(() => {
      finish([]);
    }, state.workPollTimeoutMs),
  };
  env.waiters.add(waiter);
  // A worker that disconnects mid-hold must not leak a waiter (or a later write to a
  // dead socket): drop it and clear its timer.
  req.on("close", () => {
    if (!settled) {
      settled = true;
      env.waiters.delete(waiter);
      clearTimeout(waiter.timer);
    }
  });
}

/**
 * Settle every held work-poll with an empty batch — invoked on server shutdown. A
 * long-poll held open is an in-flight request that `httpServer.close()` waits on and
 * an armed timer that keeps the event loop alive, so without this a graceful
 * shutdown while a worker is mid-poll hangs for up to
 * {@link BridgeState.workPollTimeoutMs}. Completing each held response lets a
 * quiescent server close promptly (the SSE / worker-channel analog in `index.ts`).
 */
export function settlePendingPolls(state: BridgeState): void {
  for (const env of state.environments.values()) {
    for (const waiter of [...env.waiters]) {
      waiter.settleEmpty();
    }
  }
}

/** Handle `POST /v1/environments/{env}/work/{id}/ack` (§3): scoped-token-authorized; clears in-flight work. */
export function handleWorkAck(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  environmentId: string,
  workId: string,
): void {
  completeWork(req, res, state, environmentId, workId, "ack");
}

/** Handle `POST /v1/environments/{env}/work/{id}/stop` (§3): scoped-token-authorized; clears in-flight work. */
export function handleWorkStop(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  environmentId: string,
  workId: string,
): void {
  completeWork(req, res, state, environmentId, workId, "stop");
}

/**
 * Enqueue one work item for an environment (the server-side ingress §3 delivers
 * from — a dequeued UI action, a launch). Returns `false` when the environment is
 * unknown. If a poll is currently held open for the environment, the item is
 * delivered on it immediately rather than waiting for the next poll.
 */
export function enqueueWork(state: BridgeState, environmentId: string, item: WorkItem): boolean {
  const env = state.environments.get(environmentId);
  if (env === undefined) {
    return false;
  }
  env.queue.push(item);
  flushWaiter(env);
  return true;
}

// --- routing ---

/** A matched §3 work route: the leg plus the environment (and, for ack/stop, the work id). */
export type WorkRoute =
  | { readonly kind: "poll"; readonly environmentId: string }
  | { readonly kind: "ack"; readonly environmentId: string; readonly workId: string }
  | { readonly kind: "stop"; readonly environmentId: string; readonly workId: string };

/**
 * Match a `GET|POST` path against the §3 work routes — `…/work/poll`,
 * `…/work/{id}/ack`, `…/work/{id}/stop` — extracting the environment (and work) id,
 * or `null` when it is not a work path. Anchored on the pinned
 * {@link BRIDGE_PROTOCOL_API_VERSION}, so a version-drifted path (`/v2/…`) fails to
 * match and 404s rather than being served — fail closed on drift. Environment and
 * work ids are server-minted UUIDs (no embedded `/`), so segment splitting is exact.
 */
export function matchWorkPath(pathname: string): WorkRoute | null {
  const segments = pathname.split("/");
  // Expect ["", "v1", "environments", {env}, "work", …tail].
  if (
    segments.length < 6 ||
    segments[0] !== "" ||
    segments[1] !== BRIDGE_PROTOCOL_API_VERSION ||
    segments[2] !== "environments" ||
    segments[4] !== "work"
  ) {
    return null;
  }
  const environmentId = segments[3];
  if (environmentId === undefined || environmentId === "") {
    return null;
  }
  const tail = segments.slice(5);
  if (tail.length === 1 && tail[0] === "poll") {
    return { kind: "poll", environmentId };
  }
  if (tail.length === 2 && (tail[1] === "ack" || tail[1] === "stop")) {
    const workId = tail[0];
    if (workId === undefined || workId === "") {
      return null;
    }
    return { kind: tail[1], environmentId, workId };
  }
  return null;
}

// --- internals ---

/** Shared ack/stop tail: validate the scoped token, drop the in-flight item, answer 204 / 404. */
function completeWork(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  environmentId: string,
  workId: string,
  action: "ack" | "stop",
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the work-${action} path`);
    return;
  }
  const env = requireScopedEnvironment(req, res, state, environmentId);
  if (env === null) {
    return;
  }
  if (!env.inFlight.delete(workId)) {
    writeError(res, 404, `ccctl: no in-flight work ${workId} to ${action} for environment ${environmentId}`);
    return;
  }
  res.writeHead(204);
  res.end();
}

/**
 * Resolve the environment addressed by `environmentId` AND authorize the request
 * with its scoped work-poll token, or write the fail-closed response and return
 * `null`. Enforces the §3 credential boundary: the presented Bearer must EQUAL the
 * environment's scoped token — the account Bearer (a different value) does not
 * authorize this leg.
 */
function requireScopedEnvironment(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  environmentId: string,
): EnvironmentRecord | null {
  const env = state.environments.get(environmentId);
  if (env === undefined) {
    writeError(res, 404, `ccctl: no environment ${environmentId}`);
    return null;
  }
  const presented = parseBearer(req.headers.authorization);
  if (presented === null || !scopedTokenMatches(presented, env.workPollToken)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeError(res, 401, "ccctl: work-poll requires the scoped per-environment token");
    return null;
  }
  return env;
}

/**
 * Constant-time equality between a presented credential and an environment's scoped
 * token. Length is compared first (never byte-compare unequal-length buffers), then
 * the bytes in constant time so the comparison does not leak the token by timing.
 */
function scopedTokenMatches(presented: string, token: EnvironmentToken): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Move every queued item into in-flight and return the batch (delivered, awaiting ack/stop). */
function drainQueue(env: EnvironmentRecord): WorkItem[] {
  const items = env.queue.splice(0, env.queue.length);
  for (const item of items) {
    env.inFlight.set(item.id, item);
  }
  return items;
}

/**
 * Deliver the queued batch to the first LIVE held poll (the enqueue→poll wake-up). A
 * waiter that is settled or already disconnected — its `close` handler not yet fired
 * — declines via {@link PollWaiter.deliverQueued}; skip it and try the next, leaving
 * the work queued (never drained into a dead response) if none is live.
 */
function flushWaiter(env: EnvironmentRecord): void {
  if (env.queue.length === 0) {
    return;
  }
  for (const waiter of [...env.waiters]) {
    if (waiter.deliverQueued()) {
      return;
    }
  }
}

/** Whether a response can no longer be written (client gone / already ended) — a write would throw. */
function isResponseClosed(res: ServerResponse): boolean {
  return res.writableEnded || res.destroyed;
}
