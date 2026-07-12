// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The environments-bridge flow — the server side (bridge-protocol §1/§2/§3),
 * conformed to the current worker's observed wire (issue #130).
 *
 * `@ccctl/server` terminates the Claude Code `--sdk-url` control transport. This
 * module owns three of its legs (§4/§5, the per-session HTTP+SSE worker channel, is
 * `worker-channel.ts`):
 *
 *   §1. **Environment register** — `POST /v1/environments/bridge`
 *       ({@link handleEnvironmentRegister}). The account Bearer authorizes it; the
 *       server mints an environment id and answers `{ environment_id }`. There is NO
 *       work-poll token — the §3 leg carries no credential.
 *   §2. **Session create** — `POST /v1/sessions` ({@link handleSessionCreate}). The
 *       account Bearer authorizes it; the server creates a {@link Session} and
 *       AUTO-ENQUEUES a `session` work item — carrying a locally-minted work-secret —
 *       for the worker to poll (§2→§3 wiring). The response is `{ session_id }`; there
 *       is NO `ws_url` (the SSE control path never reads one).
 *   §3. **Work delivery** — `GET …/work/poll` ({@link handleWorkPoll}), long-polled
 *       and carrying NO credential. It answers a SINGLE {@link WorkItem} (or an empty
 *       body — "no work"), never a `{ work: [...] }` envelope, under a reclaim model
 *       (no ack/stop).
 *
 * **Two-credential boundary (HARD, #130).** The account OAuth Bearer rides §1/§2
 * ONLY. It is a strict NON-PERSISTING pass-through: validated for RECEIPT via
 * {@link parseBearer}, then dropped — never written into an {@link EnvironmentRecord},
 * a {@link Session}, a response body, or a log. The per-session
 * {@link SessionIngressToken} the server mints into the §2 work-secret is NOT the
 * account Bearer, authorizes the §4/§5 channel INSTEAD, and is likewise never
 * persisted or logged. The §3 poll carries neither — it is uncredentialed.
 *
 * **Fail closed on drift.** Pinned paths come from `@ccctl/core`
 * ({@link SESSIONS_PATH} et al.); an unknown `permission_mode` (§2) or a malformed
 * body is a `400`, a missing account Bearer on §1/§2 a `401`, an unknown environment
 * a `404` — never a silent accept.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BRIDGE_PROTOCOL_API_VERSION,
  createSession,
  formatAuthority,
  sessionIngressToken,
  SESSIONS_PATH,
  WORK_SECRET_VERSION,
  type HostEndpoint,
  type Session,
  type WorkItem,
  type WorkSecret,
} from "@ccctl/core";
import { parseBearer } from "./bearer.js";
import { readJsonBody, writeError, writeJson } from "./http-response.js";
import {
  parseEnvironmentRegisterBody,
  parseSessionCreateBody,
  toEnvironmentRegisterResponseWire,
  toWorkItemWire,
} from "./bridge-wire.js";
import { toSessionCreateResponseWire } from "./session-create-wire.js";

/** Hard ceiling on a bridge request body (1 MiB) — a control-plane body fits well within it. */
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024;

/**
 * Default long-poll hold (25 s): how long a `…/work/poll` with an empty queue is
 * held open before it answers with an empty body, so the worker re-polls promptly
 * without a tight loop. Injectable via {@link BridgeState.workPollTimeoutMs} so a
 * test drives a short, deterministic timeout.
 */
export const DEFAULT_WORK_POLL_TIMEOUT_MS = 25_000;

/** A work-poll response held open until work arrives or the long-poll window lapses. */
interface PollWaiter {
  /**
   * Deliver the next queued item to this held poll IF it is still live, taking it
   * from the queue UNDER the settled guard (so a settled or already-disconnected poll
   * never strands work, nor throws a write-after-end out of {@link enqueueWork}).
   * Returns whether it delivered.
   */
  readonly deliverQueued: () => boolean;
  /** Settle the held poll with an empty body — the long-poll timeout and the shutdown drain. */
  readonly settleEmpty: () => void;
  /** The long-poll timeout timer, cleared when the poll is settled early. */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Server-side record of one bridged environment: its id, its cap, and its work queue. */
export interface EnvironmentRecord {
  /** Server-assigned environment id (interpolated into the §3 work-poll path). */
  readonly id: string;
  /** The concurrent-session cap the environment declared at register. */
  readonly maxSessions: number;
  /** Work awaiting delivery, FIFO. A poll takes ONE item; there is no ack (reclaim model). */
  readonly queue: WorkItem[];
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
  /** The bound address, so §2 can mint the work-secret's `api_base_url` pointing back at this server. */
  readonly address: HostEndpoint;
  /** Long-poll hold before an empty `…/work/poll` answers (ms). */
  readonly workPollTimeoutMs: number;
}

/**
 * Handle `POST /v1/environments/bridge` (§1). Requires the account Bearer (present →
 * validated for receipt, then dropped; never persisted), parses the body fail-closed
 * (new `machine_name` / nullable `git_repo_url` / `metadata` shape), mints an
 * environment id, records the environment, and answers `201` with `{ environment_id }`.
 */
export function handleEnvironmentRegister(req: IncomingMessage, res: ServerResponse, state: BridgeState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the environment-register path`);
    return;
  }
  // Account Bearer (§1/§2 only): required, non-persisting. Parsed to confirm receipt
  // and discarded — it is never stored on the EnvironmentRecord.
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
    state.environments.set(id, {
      id,
      maxSessions: body.maxSessions,
      queue: [],
      waiters: new Set<PollWaiter>(),
    });
    writeJson(res, 201, toEnvironmentRegisterResponseWire(id));
  });
}

/**
 * Handle `POST /v1/sessions` (§2). Requires the account Bearer (non-persisting),
 * parses the body fail-closed (including the pinned `permission_mode`), creates a
 * `connecting` {@link Session}, AUTO-ENQUEUES its `session` work item — with a
 * locally-minted work-secret — for the worker to poll, and answers `201` with the
 * golden-pinned `{ session_id }` wire (NO `ws_url`).
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
    state.sessions.set(sessionId, createSession(sessionId));
    // §2→§3 wiring: enqueue the session-dispatch work item (with its minted work-secret)
    // so the worker's next poll delivers it. The account Bearer is NOT carried here — the
    // work-secret's session_ingress_token is the per-session credential, minted locally.
    enqueueSessionWork(state, sessionId);
    // Serialize through the golden-pinned wire seam (ADR-001), never the core object
    // directly — the §2 response IS the `{ session_id }` body the worker parses.
    writeJson(res, 201, toSessionCreateResponseWire({ sessionId }));
  });
}

/**
 * Handle `GET /v1/environments/{env}/work/poll` (§3). Carries NO credential — the
 * observed worker presents none, so the poll is not gated on a token. Delivers the
 * next queued item immediately as a SINGLE {@link WorkItem}; otherwise long-polls,
 * holding the response open until an item is enqueued or
 * {@link BridgeState.workPollTimeoutMs} lapses (then an empty body = "no work"). The
 * `reclaim_older_than_ms` / `poll_interval_ms` query params are accepted and ignored
 * at this slice (delivery is at-most-once; a reclaim/visibility timeout is a later item).
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
  const env = state.environments.get(environmentId);
  if (env === undefined) {
    writeError(res, 404, `ccctl: no environment ${environmentId}`);
    return;
  }
  const queued = env.queue.shift();
  if (queued !== undefined) {
    writeJson(res, 200, toWorkItemWire(queued));
    return;
  }
  // Nothing queued: hold the response open (long-poll). `finish` is guarded so an
  // enqueue that races the timeout, a client disconnect, and a shutdown drain all
  // resolve the held response exactly once.
  let settled = false;
  const finish = (item: WorkItem | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    env.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (item !== null) {
      writeJson(res, 200, toWorkItemWire(item));
    } else {
      // 200 + empty body = "no work" (the wire has no envelope to represent empty).
      res.writeHead(200);
      res.end();
    }
  };
  const waiter: PollWaiter = {
    deliverQueued: () => {
      if (settled || isResponseClosed(res)) {
        return false;
      }
      const next = env.queue.shift();
      if (next === undefined) {
        return false;
      }
      finish(next);
      return true;
    },
    settleEmpty: () => {
      finish(null);
    },
    timer: setTimeout(() => {
      finish(null);
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
 * Settle every held work-poll with an empty body — invoked on server shutdown. A
 * long-poll held open is an in-flight request that `httpServer.close()` waits on and
 * an armed timer that keeps the event loop alive, so without this a graceful shutdown
 * while a worker is mid-poll hangs for up to {@link BridgeState.workPollTimeoutMs}.
 * Completing each held response lets a quiescent server close promptly (the SSE /
 * worker-channel analog in `index.ts`).
 */
export function settlePendingPolls(state: BridgeState): void {
  for (const env of state.environments.values()) {
    for (const waiter of [...env.waiters]) {
      waiter.settleEmpty();
    }
  }
}

/**
 * Enqueue one work item for an environment (the server-side ingress §3 delivers from —
 * a session-create, a launch). Returns `false` when the environment is unknown. If a
 * poll is currently held open for the environment, the item is delivered on it
 * immediately rather than waiting for the next poll. Exported for direct test-drive;
 * it is NOT on the public {@link CcctlServer} surface (secret-minting is server-owned,
 * so external callers create a session rather than hand-build a work item).
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

/**
 * Match a `GET` path against the §3 work-poll route — `/v1/environments/{env}/work/poll`
 * — returning the environment id, or `null` when it is not the work-poll path. Anchored
 * on the pinned {@link BRIDGE_PROTOCOL_API_VERSION}, so a version-drifted path (`/v2/…`)
 * fails to match and 404s rather than being served — fail closed on drift. The
 * environment id is a server-minted UUID (no embedded `/`), so segment splitting is exact.
 */
export function matchWorkPollPath(pathname: string): string | null {
  const segments = pathname.split("/");
  // Expect exactly ["", "v1", "environments", {env}, "work", "poll"].
  if (
    segments.length !== 6 ||
    segments[0] !== "" ||
    segments[1] !== BRIDGE_PROTOCOL_API_VERSION ||
    segments[2] !== "environments" ||
    segments[4] !== "work" ||
    segments[5] !== "poll"
  ) {
    return null;
  }
  const environmentId = segments[3];
  return environmentId === undefined || environmentId === "" ? null : environmentId;
}

// --- internals ---

/**
 * Mint and enqueue the `session` work item for a freshly-created session. Builds the
 * work-secret LOCALLY — a fresh {@link SessionIngressToken} (high-entropy, NOT the
 * account Bearer) plus this server's `api_base_url` — base64url-encodes it, and
 * enqueues `{ id, secret, data: { type: "session", id: sessionId } }` for the worker
 * to poll. Enqueues to the most-recently-registered environment; when none is
 * registered the session is created but nothing is dispatched (the multi-environment
 * target selector is a later item, carried in the session-create body).
 */
function enqueueSessionWork(state: BridgeState, sessionId: string): void {
  const env = latestEnvironment(state);
  if (env === undefined) {
    return;
  }
  const workSecret: WorkSecret = {
    version: WORK_SECRET_VERSION,
    // A scoped per-session credential, minted locally — distinct from the account
    // Bearer by construction, never persisted or logged.
    session_ingress_token: sessionIngressToken(randomBytes(24).toString("base64url")),
    api_base_url: `http://${formatAuthority(state.address.host, state.address.port)}`,
  };
  const secret = Buffer.from(JSON.stringify(workSecret), "utf8").toString("base64url");
  enqueueWork(state, env.id, { id: randomUUID(), secret, data: { type: "session", id: sessionId } });
}

/** The most-recently-registered environment (Maps preserve insertion order), or `undefined` when none. */
function latestEnvironment(state: BridgeState): EnvironmentRecord | undefined {
  let latest: EnvironmentRecord | undefined;
  for (const env of state.environments.values()) {
    latest = env;
  }
  return latest;
}

/**
 * Deliver the next queued item to the first LIVE held poll (the enqueue→poll wake-up).
 * A waiter that is settled or already disconnected — its `close` handler not yet fired
 * — declines via {@link PollWaiter.deliverQueued}; skip it and try the next, leaving the
 * work queued (never drained into a dead response) if none is live.
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
