// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The environments-bridge flow — the server side (bridge-protocol §1/§2/§3),
 * conformed to the current worker's observed wire (issues #130, #154).
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
 *       body — "no work"), never a `{ work: [...] }` envelope. Delivery is at-most-once
 *       (the poll dequeues); there is no ack-driven redelivery. After delivery the
 *       worker drives the item's lifecycle with `POST …/work/{workId}/{ack,heartbeat,stop}`
 *       ({@link handleWorkLifecycle}), which the server acknowledges `200` (issue #154).
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
import { claimPendingLaunch, type PendingLaunchState } from "./pending-launch.js";
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
  /**
   * Work awaiting delivery, FIFO. A poll takes ONE item (delivery is at-most-once —
   * the poll dequeues, no ack-driven redelivery). The worker's subsequent
   * `…/work/{workId}/{ack,heartbeat,stop}` are acknowledged (200) but carry no
   * queue-state change at this slice — the item was already dequeued at poll (#154).
   */
  readonly queue: WorkItem[];
  /** Poll responses held open awaiting work (at most one per worker at this slice). */
  readonly waiters: Set<PollWaiter>;
}

/**
 * The per-server state the environments-bridge legs read and update. The overall
 * {@link CcctlServer} state satisfies this structurally, so the handlers stay
 * decoupled from the HTTP wiring in `index.ts`.
 *
 * Extends {@link PendingLaunchState} because §2 is where a LAUNCHED session's worker checks in
 * (#33): registration is the event that claims a pending launch, and a claim can retire that
 * launch's placeholder row outright (`pending-launch.ts` § Correlation) — so the registration leg
 * genuinely reaches the sessions map, the relays and the pending registry, and says so.
 */
export interface BridgeState extends PendingLaunchState {
  /** Environments registered on this server, keyed by environment id. */
  readonly environments: Map<string, EnvironmentRecord>;
  /** The bound address, so §2 can mint the work-secret's `api_base_url` pointing back at this server. */
  readonly address: HostEndpoint;
  /** Long-poll hold before an empty `…/work/poll` answers (ms). */
  readonly workPollTimeoutMs: number;
}

/**
 * Handle `POST /v1/environments/bridge` (§1). Requires the account Bearer (present →
 * validated for receipt, then dropped; never persisted), parses the body fail-closed
 * (new `machine_name` / nullable `git_repo_url` / `metadata` shape), mints an
 * environment id, records the environment, and answers `200` with `{ environment_id }`.
 * The status is `200`, NOT `201`: the observed worker rejects a non-200 register
 * (`Registration: Failed with status 201`), so a `201` fails its handshake (issue #154).
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
    // Registration §1 (#61): a worker's environment is now on the bridge. The account Bearer that
    // authorized this leg is NEVER a field here — the loggable shape omits it by construction.
    state.logger.log({
      category: "registration",
      level: "info",
      event: "environment-registered",
      environmentId: id,
      sessionId: null,
      detail: `max_sessions=${String(body.maxSessions)}`,
    });
    // 200, not 201: the observed worker rejects a non-200 register response (#154).
    writeJson(res, 200, toEnvironmentRegisterResponseWire(id));
  });
}

/**
 * Handle `POST /v1/sessions` (§2). Requires the account Bearer (non-persisting),
 * parses the body fail-closed (including the pinned `permission_mode`), creates a
 * `connecting` {@link Session}, AUTO-ENQUEUES its `session` work item — with a
 * locally-minted work-secret — for the worker to poll, and answers `201` with the
 * golden-pinned `{ session_id }` wire (NO `ws_url`).
 *
 * **This is also where a LAUNCHED session's registration lands (#33).** A worker the server
 * launched itself (UC2) already has a `registering` session waiting for it in the registry, so
 * before minting a fresh id this leg asks whether THIS registration is that one
 * ({@link claimPendingLaunch}, matched on the launch's `cwd` + `permission_mode`). The claim is what
 * disarms that launch's eviction timer — so a session that DID register can no longer be reaped as a
 * ghost, which would close its terminal out from under a live session — and, when the match is
 * unambiguous, it hands back the pending session's id so the row the operator is already watching
 * advances IN PLACE from `registering` to `connecting` rather than a second row appearing beside it.
 *
 * A fresh id is minted in every other case, and both of them are honest: a registration matching no
 * pending launch is an ATTACHED session (UC1) — not something this server launched — exactly as
 * before; and a registration whose match is AMBIGUOUS (two launches shared one cwd + mode) is a
 * launched session this server cannot pin to a specific terminal, so it is deliberately given a new
 * identity instead of a possibly-wrong one (`pending-launch.ts` § Correlation).
 *
 * Either way the session is (re)born here through {@link createSession} from the OBSERVED
 * `permission_mode`, so its life-long `notificationsDegraded` marker is derived from what the worker
 * actually runs, never from what a launch merely asked for.
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
      writeError(res, 400, "ccctl: malformed session-create body (bad session_context/source/permission_mode)");
      return;
    }
    // Is this the worker of a session THIS server launched (#33)? If so, claim its pending
    // `registering` session — reuse that id (the list row advances in place) and disarm its
    // eviction timer. If not, this is an attached session (UC1): mint a fresh id, as ever.
    const sessionId = claimPendingLaunch(state, body.context.cwd, body.permissionMode) ?? randomUUID();
    // The session is marked at birth from its OBSERVED permission mode (a non-prompting mode
    // auto-approves some class of permission decision rather than prompting on it); the marker
    // is life-long because ccctl derives it once here and never re-reads the mode — not because
    // the mode is immutable (the worker exposes a mid-run `set_permission_mode`, which ccctl does
    // not track, so the marker can go stale — #272). ADVISORY only — it does NOT mean the session
    // cannot emit `requires_action`, and nothing gates a notification on it (#265;
    // `@ccctl/core` § `Session.notificationsDegraded`).
    state.sessions.set(sessionId, createSession(sessionId, body.permissionMode));
    // Registration §2 (#61): a `connecting` session is born on the bridge. The account Bearer that
    // authorized this leg is never a field here (loggable shape omits it by construction).
    state.logger.log({
      category: "registration",
      level: "info",
      event: "session-created",
      environmentId: latestEnvironment(state)?.id ?? "unregistered",
      sessionId,
      detail: `permission_mode=${body.permissionMode}`,
    });
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
  // §3 delivery trail (#61): the work item's id + type + session id ONLY — NEVER `item.secret`, which
  // base64url-encodes the WorkSecret (and its session_ingress_token). The loggable shape has no field
  // for the secret, so redaction here is by construction, not by remembering to omit it.
  const logDelivered = (item: WorkItem): void => {
    state.logger.log({
      category: "registration",
      level: "info",
      event: "work-delivered",
      environmentId,
      sessionId: item.data.id ?? null,
      detail: `work ${item.id} (${item.data.type})`,
    });
  };
  const queued = env.queue.shift();
  if (queued !== undefined) {
    logDelivered(queued);
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
      logDelivered(item);
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
 * Handle `POST /v1/environments/{env}/work/{workId}/{ack,heartbeat,stop}` (§3
 * work-item lifecycle, issue #154). After the poll (§3) delivers the session work
 * item, the worker drives its lifecycle with three sibling verbs; before this leg was
 * routed they all 404'd (only `…/work/poll` matched), which the worker surfaces as its
 * generic "Remote Control may not be available for this organization" text — a routing
 * gap, NOT an entitlement problem. Each verb is acknowledged `200`:
 *
 *   - `ack` — the worker confirms receipt of the delivered item. Delivery already
 *     dequeued it (at-most-once poll, {@link EnvironmentRecord.queue}), so there is
 *     nothing to re-dequeue here — the ack is a protocol confirmation.
 *   - `heartbeat` — per-item liveness; a bare `200`.
 *   - `stop` — the worker is terminating the session's child; the server acknowledges.
 *     The child teardown is worker-driven, so there is no server-side effect at this
 *     slice beyond the `200`.
 *
 * Carries NO credential, like the §3 poll it follows. Fails closed `405` (wrong
 * method) / `404` (unknown environment); the `workId` is not validated against
 * delivered items (none are tracked post-delivery under the reclaim model). The body,
 * if any, is drained and ignored.
 */
export function handleWorkLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  state: BridgeState,
  route: WorkLifecycleRoute,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the work-${route.verb} path`);
    return;
  }
  if (!state.environments.has(route.environmentId)) {
    writeError(res, 404, `ccctl: no environment ${route.environmentId}`);
    return;
  }
  req.resume(); // drain the (ignorable) body so the socket does not stall.
  writeJson(res, 200, {});
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

/** One of the three §3 work-item lifecycle verbs a worker POSTs after delivery (#154). */
export type WorkLifecycleVerb = "ack" | "heartbeat" | "stop";

/** A matched §3 work-item lifecycle route: the environment, the delivered item's id, and the verb. */
export interface WorkLifecycleRoute {
  readonly environmentId: string;
  readonly workId: string;
  readonly verb: WorkLifecycleVerb;
}

/**
 * Match a `POST` path against the §3 work-item lifecycle routes —
 * `/v1/environments/{env}/work/{workId}/{ack,heartbeat,stop}` — returning the
 * environment id, work id, and verb, or `null` when it is not one (issue #154).
 * Anchored on the pinned {@link BRIDGE_PROTOCOL_API_VERSION}, so a version-drifted
 * path 404s rather than being served — fail closed on drift. Distinct from
 * {@link matchWorkPollPath} by shape: the poll is 6 segments (`…/work/poll`), a
 * lifecycle path is 7 (`…/work/{workId}/{verb}`), so the two never collide. Both ids
 * are server-minted UUIDs (no embedded `/`), so segment splitting is exact.
 */
export function matchWorkLifecyclePath(pathname: string): WorkLifecycleRoute | null {
  const segments = pathname.split("/");
  // Expect exactly ["", "v1", "environments", {env}, "work", {workId}, {verb}].
  if (
    segments.length !== 7 ||
    segments[0] !== "" ||
    segments[1] !== BRIDGE_PROTOCOL_API_VERSION ||
    segments[2] !== "environments" ||
    segments[4] !== "work"
  ) {
    return null;
  }
  const environmentId = segments[3];
  const workId = segments[5];
  const verb = segments[6];
  if (environmentId === undefined || environmentId === "" || workId === undefined || workId === "") {
    return null;
  }
  if (verb !== "ack" && verb !== "heartbeat" && verb !== "stop") {
    return null;
  }
  return { environmentId, workId, verb };
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
