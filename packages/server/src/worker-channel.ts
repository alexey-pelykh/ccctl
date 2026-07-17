// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The per-session worker channel — bridge-protocol §4/§5, the server side, over
 * **HTTP + Server-Sent Events** (issue #130).
 *
 * The current Claude Code `--sdk-url` worker does NOT open a WebSocket: it opens a
 * held-open SSE stream for the server→worker downstream and POSTs its own upstream
 * legs. This module terminates that channel, rooted at
 * `{@link workerChannelPath}` (`/v1/code/sessions/{id}/worker`):
 *
 *   - `POST …/worker/register` `{}` → `{ worker_epoch }` ({@link handleWorkerRegister}).
 *     The server stamps a monotonic per-session epoch; a later register supersedes it,
 *     and an upstream POST carrying a superseded epoch fails closed `409` (the worker
 *     then exits).
 *   - `GET …/worker/events/stream` → a held-open `text/event-stream` downstream
 *     ({@link handleWorkerEventsStream}); the server pushes `client_event` frames down
 *     it (turn injection / steer relay).
 *   - `POST …/worker/events` `{ worker_epoch, events: [{ payload }] }` → the upstream
 *     transcript leg ({@link handleWorkerEvents}); each payload is relayed to the UI
 *     SSE (#13, {@link broadcastEvent}) — this is where a turn's output returns — and a
 *     `worker_status` payload ALSO feeds the session's `activity` ({@link foldWorkerStatus},
 *     #39). This is the leg carrying the RICH frame
 *     (`payload: { status, detail, sequence_num }`), so it is where the human-ready detail
 *     enters the model.
 *   - `PUT …/worker` `{ worker_status, worker_epoch, external_metadata, sequence_num }` → the
 *     status gate ({@link handleWorkerStatus}); `idle` means "ready for a turn". It MUST `200`
 *     or the worker exits. The server derives the session's `activity` from it
 *     ({@link applyWorkerStatus}) — a BARE status, no detail field, so a `requires_action`
 *     re-affirmation keeps the detail §5 captured. `GET …/worker` on the SAME bare path is
 *     the child's worker-state restore ({@link handleWorkerStateRestore}) — an empty `200`
 *     (issue #154); the path is method-multiplexed (GET restore / PUT status).
 *   - `POST …/worker/heartbeat` → liveness ({@link handleWorkerHeartbeat},
 *     {@link recordHeartbeat}); `POST …/worker/events/delivery`
 *     `{ worker_epoch, updates: [{ event_id, status }] }` → the worker's per-event
 *     downstream acks ({@link handleWorkerDelivery}).
 *
 * **Status ORDERING (#201).** Both status legs carry an OPTIONAL `sequence_num` — the worker's
 * per-session counter, one value per status REPORT (both legs of one transition share it), so ONE
 * counter spans both legs and a frame's position is comparable whichever leg it took; `@ccctl/core`'s
 * `WorkerStatusEvent` pins the emitter contract. A frame stamped strictly below the highest already
 * applied ({@link WorkerChannelRecord.highestStatusSeq}) is refused as stale
 * ({@link refuseStaleStatusFrame}): it moves nothing, is dropped from the §5 relay (the UI renders a
 * `worker_status` as the LIVE current turn, so forwarding a frame the model ruled stale would publish
 * a known-false claim), is LOGGED rather than silently discarded, and is still answered `200` — the
 * worker did nothing wrong, and a 4xx would kill it over a benign reorder. An absent sequence applies
 * (last-write-wins, as before #201), so an older worker build is unaffected. The mark is scoped to the
 * current epoch and never crosses a re-register; the guard reads no clock, which is exactly why it
 * cannot wedge a session the way #39's removed clock-derived guard could.
 *
 * **Idle-threshold nudge (#41).** From the observed `worker_status: idle` and the heartbeat — the only
 * two idle-relevant signals a worker that emits no headless "idle for X" gives — the server times how
 * long each session stays CONTINUOUSLY idle. Idle past {@link WorkerChannelState.sessionIdleThresholdMs}
 * while still heartbeat-live raises a per-session "idle > X" informational event onto the UI relay
 * ({@link reconcileIdleTimer} arms/resets it off the observed status; {@link fireIdleEvent} raises it).
 * Activity — a status change off idle, or a turn injected down the channel — resets it. This is the
 * SEPARATE informational class the blocking needs-you (`requires_action`) trigger is NOT.
 *
 * **Needs-input notification (#43).** The BLOCKING counterpart to the idle nudge: when a session
 * TRANSITIONS into `requires_action` — the needs-you signal ({@link isInputAwaited}) — the server raises
 * a per-session "needs input" notification NAMING it onto the same UI relay ({@link reconcileNeedsInput}
 * decides it off the observed status on both the §4 and §5 legs; {@link needsInputEvent} builds it),
 * carrying the human-ready detail of what it awaits. Composed with liveness (a heartbeat-stale awaiter is
 * eviction's job, not a nudge) and — via the registry-absence of a closed session — lifecycle. This is
 * the blocking class ("it is waiting on you") the idle nudge ("you left this sitting") is not; the two
 * are discriminated by their event `type`.
 *
 * **Two firewalled notification classes (#44).** The two events above are not merely two `type`s — they
 * are two CLASSES a consumer must HANDLE differently, so each payload now also carries its class and the
 * handling policy that rides with it ({@link NotificationClassPolicy}): the needs-input notification is
 * {@link NOTIFICATION_CLASS_BLOCKING} (high-urgency, re-nudgeable, never batched), the idle nudge is
 * {@link NOTIFICATION_CLASS_INFORMATIONAL} (quiet, batchable, never re-nudged). The two are FIREWALLED —
 * each builder stamps one whole frozen policy ({@link BLOCKING_NOTIFICATION} / {@link INFORMATIONAL_NOTIFICATION})
 * by name and every policy field is derived from the class, so an informational event can never escalate
 * into or masquerade as the blocking class (there is no seam that mixes the two).
 *
 * **Turn injection** ({@link injectUserTurn}) pushes a `client_event` frame down the
 * held-open downstream. The event name is `client_event`; the `data` is
 * `{ sequence_num, event_id, event_type: "message", payload }`, and `payload.type`
 * is what the worker demuxes on (`user` | `control_request` | `control_response`). A
 * user turn carries a `{ type: "user", message, … }` payload; a UI steer
 * ({@link dispatchControlRequest}) carries the `control_request`. Downstream frames
 * carry no `worker_epoch`; a re-sent `uuid` is de-duplicated by the worker.
 *
 * **Two-credential boundary (HARD, #130).** No account Bearer rides this channel —
 * it is authorized (in the credentialed wave) by the per-session
 * {@link SessionIngressToken} the server minted into the work-secret, NEVER the
 * account Bearer. This slice is loopback-hermetic and does not yet enforce the
 * ingress token on the channel; the token boundary lives in the work-secret mint
 * (`environments-bridge.ts`).
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  applyWorkerStatus,
  applyWorkerStatusFrame,
  asWorkerStatusSequence,
  BRIDGE_PROTOCOL_API_VERSION,
  isInputAwaited,
  isSessionStale,
  isStaleWorkerStatusSequence,
  isWorkerStatus,
  markSessionReady,
  recordHeartbeat,
  requiresActionEnrichmentFromFrame,
  workerStatusSequenceFromFrame,
  type ControlFrame,
  type ControlRequest,
  type JsonValue,
  type Logger,
  type RequiresActionEnrichment,
  type Session,
} from "@ccctl/core";
import { broadcastEvent, type SessionEventRelays } from "./event-stream.js";
import { type HookInstall } from "./hook-settings-installer.js";
import { readJsonBody, writeError, writeJson } from "./http-response.js";
import { closeSession } from "./session-close.js";

/** Hard ceiling on a worker-channel request body (1 MiB) — a control-plane batch fits within it. */
const MAX_WORKER_BODY_BYTES = 1024 * 1024;

/**
 * Default interval (ms) between the per-session downstream **liveness frames** (#166).
 *
 * The `--sdk-url` worker's SSE reader enforces a ~45s liveness timeout on its held-open
 * downstream and counts ONLY real `client_event` frames toward it — a comment-only
 * keepalive (`:` line) does NOT reset it. So an idle session, whose downstream is otherwise
 * silent after the opening comment, is guaranteed to hit the timeout and flap
 * (connect → timeout → reconnect). Emitting a no-op `client_event` every
 * {@link DEFAULT_WORKER_LIVENESS_INTERVAL_MS} holds the stream open indefinitely.
 *
 * 20s sits comfortably below the ~45s window with margin for jitter: even a delayed second
 * frame (at ~40s) still lands before the timeout, whereas a 25–30s interval leaves a delayed
 * frame racing the deadline. Overridable per server ({@link ServerConfig.workerLivenessIntervalMs}).
 */
export const DEFAULT_WORKER_LIVENESS_INTERVAL_MS = 20_000;

/**
 * Default grace window (ms) before a session whose worker downstream has gone null is CLOSED and
 * evicted from the registry (#173).
 *
 * A worker dropping its held-open downstream is NORMAL on a transient reconnect — it re-registers
 * with a fresh downstream after a network blip — so a null downstream ALONE must never evict
 * (reconnect-safety). Eviction is instead **liveness-driven** (issue #173's recommended policy,
 * leaning on the #41 heartbeat): the downstream close only ARMS a check this many ms later, and the
 * check evicts ONLY when the downstream is STILL null AND no heartbeat has landed within the window
 * ({@link isSessionStale}) — i.e. the worker has genuinely gone silent, not merely dropped its
 * stream. A still-beating worker (downstream dropped but heartbeats continuing) is retained.
 *
 * 30s matches {@link DEFAULT_HEARTBEAT_STALE_AFTER_MS}: a session with no downstream and no
 * heartbeat for a full staleness window is presumed terminally gone. Comfortably longer than a
 * worker's reconnect/liveness cycle, so a genuine reconnect re-registers well before the window
 * lapses. Overridable per server ({@link ServerConfig.sessionEvictionGraceMs}); a test passes a
 * short value to exercise eviction deterministically.
 */
export const DEFAULT_SESSION_EVICTION_GRACE_MS = 30_000;

/**
 * Default threshold (ms) a session may stay continuously idle before the server raises the "idle > X"
 * informational event that names it (#41).
 *
 * The `--sdk-url` worker sends no headless "idle for X" signal — it reports the discrete
 * `worker_status: idle` ("ready for a turn") and keeps heart-beating, but never "still idle, X later".
 * So the server times it: it arms a per-session one-shot the moment it OBSERVES the session go idle
 * ({@link WorkerChannelRecord.idleTimer}), and — X later, if the session is STILL idle AND still
 * heartbeat-live ({@link isSessionStale}) — raises the event. Activity resets it (a status change off
 * idle, or a turn injected down the channel), so it measures a CONTINUOUS idle stretch, not cumulative
 * idle. This is the SEPARATE informational class the needs-you (`requires_action`) trigger is NOT
 * (`@ccctl/core` § `isInputAwaited`): idle-too-long is a soft "you left this session sitting" nudge, not
 * a blocking "it is waiting on you".
 *
 * Chosen at 120_000 ms (2 min): a DELIBERATE design value, not a derived one (#42). It is well above
 * the liveness/eviction windows (20s / 30s) — those bound a worker presumed GONE; this bounds one that
 * is demonstrably ALIVE yet unused — so the nudge fires only after a genuine lull an operator would want
 * flagged, never right after every turn settles to idle. It is the DEFAULT of the config-time knob
 * (#42): overridable per server ({@link ServerConfig.sessionIdleThresholdMs}), which the server validates
 * as a positive integer at start; a test passes a short value to exercise it deterministically, never a
 * hidden magic number.
 */
export const DEFAULT_SESSION_IDLE_THRESHOLD_MS = 120_000;

/**
 * The `type` discriminant of the "idle > X" informational event (#41) the server broadcasts onto a
 * session's UI stream when it has stayed idle past {@link WorkerChannelState.sessionIdleThresholdMs}.
 * `ccctl_`-namespaced — like the {@link LIVENESS_PAYLOAD} `ccctl_liveness` frame — so it never collides
 * with a real worker `stream-json` payload; the UI transcript decoder keys on `control_event` and
 * surfaces everything else verbatim, so this server-originated event rides the relay without being
 * mistaken for a transcript frame.
 */
export const SESSION_IDLE_EVENT_TYPE = "ccctl_session_idle";

/**
 * The `type` discriminant of the blocking "needs input" notification (#43) the server broadcasts onto a
 * session's UI stream when it TRANSITIONS into `requires_action` — the needs-you signal (`@ccctl/core`
 * § {@link isInputAwaited}). The blocking counterpart of {@link SESSION_IDLE_EVENT_TYPE}: same `ccctl_`
 * namespace (so it never collides with a real worker `stream-json` payload — the UI transcript decoder
 * keys on `control_event` and surfaces everything else verbatim), same per-session relay, distinguished
 * from the informational idle nudge by this `type`.
 */
export const SESSION_NEEDS_INPUT_EVENT_TYPE = "ccctl_session_needs_input";

/**
 * The BLOCKING notification class (#44): "it is waiting on you". The value of the `notification_class`
 * field the {@link needsInputEvent} payload carries — the discriminant a consumer keys ITS HANDLING on,
 * one level above the per-event {@link SESSION_NEEDS_INPUT_EVENT_TYPE} `type`. Its handling policy
 * ({@link BLOCKING_NOTIFICATION}) is high-urgency and re-nudgeable: an unaddressed blocking event may be
 * re-raised, and is never quietly batched.
 */
export const NOTIFICATION_CLASS_BLOCKING = "blocking";

/**
 * The INFORMATIONAL notification class (#44): "you left this sitting". The value of the
 * `notification_class` field the {@link idleEvent} payload carries — the firewalled counterpart of
 * {@link NOTIFICATION_CLASS_BLOCKING}. Its handling policy ({@link INFORMATIONAL_NOTIFICATION}) is quiet
 * (low urgency) and batchable, and NEVER re-nudged.
 */
export const NOTIFICATION_CLASS_INFORMATIONAL = "informational";

/**
 * The handling policy a notification class fixes (#44) — the fields a consumer reads to decide HOW to
 * surface a server-raised session event, independent of the per-event `type`:
 *   - `notification_class` — {@link NOTIFICATION_CLASS_BLOCKING} | {@link NOTIFICATION_CLASS_INFORMATIONAL};
 *   - `urgency` — `"high"` (blocking: surface now) vs `"low"` (informational: quiet);
 *   - `renudge` — whether an unaddressed event of this class may be RE-raised (AC1 eligible / AC2 never);
 *   - `batchable` — whether it may be coalesced into a batch rather than surfaced immediately (AC2).
 *
 * Every field is DERIVED from the class in the two frozen policies below, never set per-event — which is
 * exactly what firewalls the two classes (AC3): an event's marking can only ever be one of those two
 * whole policies, so an informational event cannot acquire a blocking event's urgency/renudge policy (or
 * vice-versa) — there is no seam that mixes them.
 */
export interface NotificationClassPolicy {
  readonly notification_class: typeof NOTIFICATION_CLASS_BLOCKING | typeof NOTIFICATION_CLASS_INFORMATIONAL;
  readonly urgency: "high" | "low";
  readonly renudge: boolean;
  readonly batchable: boolean;
}

/**
 * The BLOCKING policy (#44 AC1): high-urgency, eligible for re-nudge, never batched. The single
 * source-of-truth the {@link needsInputEvent} builder stamps — frozen so the shared policy cannot be
 * mutated in place into the informational shape (the runtime half of the firewall; each emitted event is
 * a fresh spread copy besides).
 */
const BLOCKING_NOTIFICATION: NotificationClassPolicy = Object.freeze({
  notification_class: NOTIFICATION_CLASS_BLOCKING,
  urgency: "high",
  renudge: true,
  batchable: false,
});

/**
 * The INFORMATIONAL policy (#44 AC2): quiet (low urgency), NEVER re-nudged, batchable. The firewalled
 * counterpart of {@link BLOCKING_NOTIFICATION} the {@link idleEvent} builder stamps — frozen for the same
 * reason.
 */
const INFORMATIONAL_NOTIFICATION: NotificationClassPolicy = Object.freeze({
  notification_class: NOTIFICATION_CLASS_INFORMATIONAL,
  urgency: "low",
  renudge: false,
  batchable: true,
});

/**
 * The live per-session worker channel: its current epoch, its held-open downstream
 * SSE (or `null` when the worker has not opened / has dropped the stream), and the
 * next downstream `client_event` sequence number.
 */
export interface WorkerChannelRecord {
  /** The current `worker_epoch`; a superseded (older) epoch on an upstream POST fails closed 409. */
  epoch: number;
  /** The held-open `worker/events/stream` response the server pushes `client_event` frames to. */
  downstream: ServerResponse | null;
  /** The next `sequence_num` / SSE `id` a pushed downstream frame carries (monotonic, starts at 1). */
  nextSeq: number;
  /**
   * The ordering high-water mark (#201): the highest `sequence_num` of any `worker_status` frame
   * APPLIED to this session's classification, or `null` when none has carried one yet. An upstream
   * frame stamped BELOW it lost a race and is refused ({@link isStaleWorkerStatusSequence}); one
   * stamped at or above it applies and advances the mark. Counts frames across BOTH status legs —
   * the §4 gate and the §5 fold share one counter, as the worker stamps one per session.
   *
   * Deliberately NOT carried across a re-register (unlike {@link nextSeq}, whose downstream ids must
   * never repeat): a new epoch is a new worker generation whose counter restarts at its own
   * beginning, so a carried mark would refuse its every frame — a wedged session, which is the exact
   * failure this guard exists to avoid. Living on the per-epoch record is what makes that reset
   * structural rather than a step someone must remember; the epoch gate in {@link readWorkerBody}
   * then guarantees every frame compared against this mark belongs to the generation that set it.
   *
   * In-memory only, never persisted: a restarted daemon has no worker generation to order for, and
   * the worker re-registers into a fresh epoch anyway.
   */
  highestStatusSeq: number | null;
  /**
   * The armed per-session **liveness interval** (#166) writing a periodic no-op `client_event`
   * down {@link downstream} to keep it past the worker's ~45s liveness timeout; `null` when no
   * downstream is held. Cleared on stream close, on supersede (a re-register bumps the epoch),
   * and on shutdown — so no frame is ever written to a reaped stream and no interval dangles.
   */
  livenessTimer: ReturnType<typeof setInterval> | null;
  /**
   * The armed grace-delayed **eviction check** (#173), scheduled when the downstream goes null to
   * decide — one grace window later — whether the session is terminally gone (→ closed + evicted)
   * or merely reconnecting (retained); `null` when no check is pending. Cleared on reconnect
   * (re-register / reopen) and on shutdown via {@link endDownstream}, so a pending eviction never
   * fires against a session whose worker came back or a server that is shutting down.
   */
  evictionTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The armed per-session **idle-threshold check** (#41): a one-shot armed when the session is
   * OBSERVED to go `idle` and firing {@link WorkerChannelState.sessionIdleThresholdMs} later to raise
   * the "idle > X" informational event; `null` when the session is not idle (or already fired).
   * Armed ONLY on a transition INTO idle — a redundant `idle` re-affirmation leaves the running timer
   * untouched, so it measures ONE continuous idle stretch, not a restart-on-every-frame clock. Cleared
   * the moment the session leaves idle (a status change, {@link reconcileIdleTimer}) or a turn/steer is
   * injected ({@link pushClientEvent}), and on every downstream teardown / supersede / shutdown via
   * {@link endDownstream} — so it never fires against a session that has moved on or been reaped.
   */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The slice of state a channel REAP touches ({@link reapWorkerChannel}) — the registry it empties, and
 * nothing else. Narrow on purpose: the emergency-stop (#76) holds no worker-channel state of its own
 * and has no business knowing this module's timers or grace windows, so it depends on the one field
 * the reap actually needs. {@link WorkerChannelState} satisfies it structurally.
 */
export interface WorkerChannelReapState {
  /** The live per-session worker channel, keyed by session id (epoch + downstream + seq). */
  readonly workerChannels: Map<string, WorkerChannelRecord>;
}

/** The per-server state the worker channel reads and updates. */
export interface WorkerChannelState extends WorkerChannelReapState {
  /** Sessions tracked by the server, keyed by ccctl session id. */
  readonly sessions: Map<string, Session>;
  /**
   * Interval (ms) between per-session downstream liveness frames (#166). Resolved once at
   * server start ({@link ServerConfig.workerLivenessIntervalMs} ??
   * {@link DEFAULT_WORKER_LIVENESS_INTERVAL_MS}); a test passes a short value to exercise the
   * timer deterministically.
   */
  readonly workerLivenessIntervalMs: number;
  /**
   * Grace window (ms) before a downstream-null session is closed + evicted (#173). Resolved once at
   * server start ({@link ServerConfig.sessionEvictionGraceMs} ??
   * {@link DEFAULT_SESSION_EVICTION_GRACE_MS}); doubles as the staleness window the eviction check
   * measures the heartbeat gap against ({@link isSessionStale}). A test passes a short value to
   * exercise eviction deterministically.
   */
  readonly sessionEvictionGraceMs: number;
  /**
   * Threshold (ms) a session may stay continuously idle before the "idle > X" informational event is
   * raised (#41). Resolved once at server start ({@link ServerConfig.sessionIdleThresholdMs} ??
   * {@link DEFAULT_SESSION_IDLE_THRESHOLD_MS}); a test passes a short value to exercise the timer
   * deterministically.
   */
  readonly sessionIdleThresholdMs: number;
  /**
   * The per-session UI Server-Sent Events relays. Every payload read off a session's
   * upstream `worker/events` leg (§5) is fanned out to the UI clients subscribed to THAT
   * SESSION's stream (#13/#20), so the upstream read path is also the source of the
   * browser's per-session stream — and a session's output never reaches another
   * session's subscribers. The "idle > X" informational event (#41) is raised onto this
   * same per-session stream ({@link fireIdleEvent}).
   */
  readonly eventRelays: SessionEventRelays;
  /**
   * The per-session `AskUserQuestion` enrichment buffer (#264, #78 Option A), keyed by ccctl session id.
   * The §5 `input_request` frame (#261) is a worker emission decorating a `requires_action` block; the
   * server buffers its {@link RequiresActionEnrichment} here on arrival ({@link bufferInputRequestEnrichment})
   * so the per-session read serves the outstanding question + tappable options to a UI that connected AFTER
   * the frame was relayed live. Dropped on transition OUT of `requires_action` ({@link reconcileEnrichmentBuffer},
   * both status legs) — mirroring the {@link capturedRequiresActionDetail} lifecycle in `@ccctl/core` — and on
   * teardown ({@link closeSession}). It is DISPLAY state ONLY: writing / dropping it never touches
   * {@link Session.activity}, so it structurally cannot set or clear the #40 needs-you signal.
   */
  readonly requiresActionEnrichments: Map<string, RequiresActionEnrichment>;
  /**
   * A launch's `AskUserQuestion` hook install record (#262, #78 Option A), keyed by ccctl session id —
   * where its settings file landed and where its hook writes a captured payload. Populated by
   * `ui-session-launch.ts` § `launchSession` right after a launch succeeds; consumed exactly once by
   * {@link reconcileHookHandoff} at the moment it observes THIS session's transition into
   * `requires_action`. A session with no entry here (a launch whose hook install failed and degraded,
   * or a test fixture that never wires one) simply gets no `AskUserQuestion` enrichment — same as
   * before this issue shipped. NOT the same map as {@link requiresActionEnrichments} above: that one
   * holds a PARSED, validated enrichment already correlated to a block; this one holds raw file paths,
   * for a block that may not even exist yet.
   */
  readonly hookInstalls: Map<string, HookInstall>;
  /**
   * The structured-log sink (#61) — the worker channel is where the daemon's stall signals live:
   * `ready` transitions, `worker_status` activity changes, staleness, and the needs-you / idle
   * notifications. Also satisfies {@link SessionCloseState.logger} for the {@link considerEviction}
   * → {@link closeSession} terminal path.
   */
  readonly logger: Logger;
}

/** A matched §4/§5 worker-channel leg plus the session it addresses. */
export type WorkerRoute =
  | { readonly leg: "register"; readonly sessionId: string }
  | { readonly leg: "events-stream"; readonly sessionId: string }
  | { readonly leg: "events"; readonly sessionId: string }
  | { readonly leg: "events-delivery"; readonly sessionId: string }
  | { readonly leg: "heartbeat"; readonly sessionId: string }
  | { readonly leg: "status"; readonly sessionId: string };

/**
 * Match a path against the §4/§5 worker-channel legs — `…/worker` (GET restore / PUT status),
 * `…/worker/register`, `…/worker/events/stream`, `…/worker/events`,
 * `…/worker/events/delivery`, `…/worker/heartbeat` — extracting the session id, or
 * `null` when it is not a worker-channel path. Anchored on the pinned
 * {@link BRIDGE_PROTOCOL_API_VERSION} (`/v1/code/sessions/{id}/worker/…`), so a
 * version-drifted path fails to match and 404s rather than being served. The session
 * id is a server-minted UUID (no embedded `/`), so segment splitting is exact.
 */
export function matchWorkerRoute(pathname: string): WorkerRoute | null {
  const segments = pathname.split("/");
  // Expect ["", "v1", "code", "sessions", {id}, "worker", …tail].
  if (
    segments.length < 6 ||
    segments[0] !== "" ||
    segments[1] !== BRIDGE_PROTOCOL_API_VERSION ||
    segments[2] !== "code" ||
    segments[3] !== "sessions" ||
    segments[5] !== "worker"
  ) {
    return null;
  }
  const sessionId = segments[4];
  if (sessionId === undefined || sessionId === "") {
    return null;
  }
  const tail = segments.slice(6);
  if (tail.length === 0) {
    return { leg: "status", sessionId };
  }
  if (tail.length === 1 && tail[0] === "register") {
    return { leg: "register", sessionId };
  }
  if (tail.length === 1 && tail[0] === "events") {
    return { leg: "events", sessionId };
  }
  if (tail.length === 1 && tail[0] === "heartbeat") {
    return { leg: "heartbeat", sessionId };
  }
  if (tail.length === 2 && tail[0] === "events" && tail[1] === "stream") {
    return { leg: "events-stream", sessionId };
  }
  if (tail.length === 2 && tail[0] === "events" && tail[1] === "delivery") {
    return { leg: "events-delivery", sessionId };
  }
  return null;
}

/**
 * Fail closed on any §4 leg addressed to a session that has not yet registered over the bridge (#33)
 * — answers `409` and returns `true` when the caller must stop.
 *
 * A `registering` session is a UC2 launch whose worker has not checked in yet. It IS in the session
 * map (that is the point — the operator watches it come up), so the "unknown session" `404` does not
 * catch it. But it is not yet ANYBODY'S: its id was minted server-side and handed to the OPERATOR,
 * while a launched worker only ever learns its own id from the §3 work item that §2 enqueues — so §2
 * necessarily precedes §4, and no legitimate §4 caller can be holding this id. The session is also
 * still EVICTABLE, and eviction reaps the session and its relay while knowing nothing about worker
 * channels: anything a §4 leg builds on it (a channel with its held-open downstream and liveness
 * interval; a refreshed heartbeat) would outlive the session that owns it.
 *
 * So the whole §4 surface is closed until §2 has run — not merely `register`, even though `register`
 * is the only leg that can CREATE a channel. A heartbeat answering `200` for a session no worker can
 * legitimately be heartbeating would undercut exactly the argument this guard rests on.
 */
function rejectIfRegistering(res: ServerResponse, session: Session, sessionId: string): boolean {
  if (session.status !== "registering") {
    return false;
  }
  writeError(res, 409, `ccctl: session ${sessionId} has not registered over the bridge yet`);
  return true;
}

/**
 * `POST …/worker/register` (§4). Mints and returns a fresh per-session
 * `worker_epoch` — monotonic, so a re-register SUPERSEDES the prior epoch and any
 * upstream POST still stamped with it fails closed 409. Ends a stale held-open
 * downstream from the superseded epoch. The `{}` body is not load-bearing (drained,
 * ignored). Fails closed 404 for an unknown session, and 409 for a session that has
 * not registered over the bridge yet ({@link rejectIfRegistering}) — this is the only
 * leg that can create a worker channel, so it is the one that must not create one on a
 * session eviction may still reap.
 */
export function handleWorkerRegister(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-register path`);
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  if (rejectIfRegistering(res, session, sessionId)) {
    return;
  }
  req.resume(); // drain the ignorable `{}` body so the socket does not stall.
  const prev = state.workerChannels.get(sessionId);
  // A re-register supersedes the prior epoch: synchronously end the stale downstream and clear its
  // liveness interval (`endDownstream` — no dangling timer, no frame written to a reaped stream,
  // #166) so the old worker's held stream is not left dangling, then bump the epoch.
  if (prev !== undefined) {
    endDownstream(prev);
  }
  const epoch = (prev?.epoch ?? 0) + 1;
  state.workerChannels.set(sessionId, {
    epoch,
    downstream: null,
    nextSeq: prev?.nextSeq ?? 1,
    // NOT `prev?.highestStatusSeq` (#201): the fresh generation's status counter restarts, so
    // inheriting the old mark would refuse its every frame. See {@link WorkerChannelRecord.highestStatusSeq}.
    highestStatusSeq: null,
    livenessTimer: null,
    evictionTimer: null,
    idleTimer: null,
  });
  // Detection trail (#61): a worker generation attached. The first register is the worker checking
  // in; a re-register SUPERSEDES the prior epoch (`prev` present), so a REPEATING one is a flapping
  // worker — exactly the churn signal the stall/leak trail exists to surface (a silent re-attach
  // would hide it). `detail` carries only the epoch (a monotonic integer), never anything the worker
  // presented, so no session-ingress token can ride this line.
  state.logger.log({
    category: "detection",
    level: "info",
    event: "worker-registered",
    sessionId,
    activity: session.activity.kind,
    detail: prev === undefined ? `registered (epoch ${epoch})` : `re-registered (epoch ${prev.epoch}→${epoch})`,
  });
  writeJson(res, 200, { worker_epoch: epoch });
}

/**
 * `GET …/worker/events/stream` (§4). Holds the response open as the server→worker
 * downstream `text/event-stream`; the server pushes `client_event` frames down it
 * (turn injection / steer). Requires the worker to have registered (the epoch the
 * channel is bound to) — an unregistered session fails closed 409. Reaped when the
 * worker disconnects. Fails closed 404/405 for an unknown session / wrong method.
 */
export function handleWorkerEventsStream(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-events-stream path`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  const record = state.workerChannels.get(sessionId);
  if (record === undefined) {
    writeError(res, 409, `ccctl: session ${sessionId} worker must register before opening the events stream`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Open with an SSE comment so headers flush immediately and the worker's stream
  // settles before the first pushed frame (a comment is ignored by an SSE reader).
  // A second open on the SAME record (no intervening re-register) supersedes the prior held
  // stream: end it and clear its still-armed liveness interval (`endDownstream`) before this one
  // takes the slot — otherwise that timer is orphaned (a later `clearLivenessTimer` only ever sees
  // the newest `record.livenessTimer`) and dangles until the first response closes. The normal
  // worker holds exactly ONE downstream per registration, so this only fires on a
  // duplicate/misbehaving open; routing it through `endDownstream` keeps "no dangling timer" total.
  endDownstream(record);
  res.write(": ccctl worker stream\n\n");
  record.downstream = res;
  // The downstream is attached and the session is now steerable, so advance its transport
  // lifecycle `connecting`→`ready` (#172). `markSessionReady` is a no-op on an already-advanced
  // session, and the reverse leg (`→closed`/`errored` on teardown) is a separate transition.
  const session = state.sessions.get(sessionId);
  if (session !== undefined) {
    const ready = markSessionReady(session);
    state.sessions.set(sessionId, ready);
    // Lifecycle transition (#61): log only a REAL advance (`markSessionReady` is a no-op on an
    // already-ready session), so a re-opened downstream does not spam a `ready` that did not move.
    if (ready.status !== session.status) {
      state.logger.log({
        category: "session",
        level: "info",
        event: "status",
        sessionId,
        status: ready.status,
        detail: `${session.status}→${ready.status}`,
      });
    }
  }
  // Arm the per-session liveness interval (#166): a no-op `client_event` every
  // `workerLivenessIntervalMs` keeps THIS held-open downstream past the worker's ~45s
  // liveness timeout — a silent idle downstream would otherwise be reaped by the worker and
  // flap. `.unref()` so a lingering interval alone never blocks process exit; it is also
  // cleared on close (below), on supersede (`handleWorkerRegister`), and on shutdown
  // (`closeWorkerChannels`).
  const timer = setInterval(() => {
    writeLivenessFrame(record, res);
  }, state.workerLivenessIntervalMs);
  timer.unref();
  record.livenessTimer = timer;
  // Reap the downstream when the worker disconnects, so a closed stream is never a
  // dangling write target — but only if it still points at THIS response, so a late
  // close of a superseded stream cannot evict a reconnect's live downstream. Clearing THIS
  // response's interval is unconditional (it belongs to this stream regardless).
  res.on("close", () => {
    clearInterval(timer);
    if (record.downstream === res) {
      record.downstream = null;
      record.livenessTimer = null;
      // The worker dropped its LIVE downstream. That is NORMAL on a transient reconnect (it
      // re-registers / reopens with a fresh downstream after a network blip), so a null downstream
      // alone must NOT evict (#173 reconnect-safety). Arm a grace-delayed liveness check that
      // evicts ONLY a terminally-gone session — downstream still null AND heartbeat lapsed (#41
      // staleness) — and RETAINS a still-beating one. Cleared on reconnect / shutdown via
      // `endDownstream`, and neutralized by an identity guard if the record was superseded.
      scheduleEviction(state, sessionId, record);
    }
  });
}

/**
 * Emit a DETECTION log event (#61) for a worker_status transition — but only when the activity KIND
 * actually MOVED (running / requires_action / idle), not on every well-formed frame. A frame that only
 * bumps `lastActivityAt` (running→running) advances the session (so the caller's `next !== session`
 * holds) yet is not a state change worth a line; logging every one would drown the running→idle and
 * idle→requires_action transitions that ARE the stall signal. Shared by the §4 gate and the §5 leg so
 * one rule governs both — the same "one derivation, both legs" discipline the reconciles follow.
 */
function logActivityTransition(state: WorkerChannelState, sessionId: string, prev: Session, next: Session): void {
  if (prev.activity.kind === next.activity.kind) {
    return;
  }
  state.logger.log({
    category: "detection",
    level: "info",
    event: "activity",
    sessionId,
    activity: next.activity.kind,
    detail: `${prev.activity.kind}→${next.activity.kind}`,
  });
}

/**
 * The ORDERING guard (#201) — `true` when this `worker_status` frame must be REFUSED as stale,
 * i.e. it is stamped with a `sequence_num` strictly below the highest already applied to this
 * session's classification within the current epoch. Shared by the §4 gate and the §5 fold so one
 * rule governs both, exactly as {@link logActivityTransition} does for the transition trail.
 *
 * Refusing is a NON-transition: it returns `true` and the caller skips the fold, leaving the
 * session — activity, `lastActivityAt`, the idle timer, the needs-you notification — untouched.
 * The frame is not an ERROR, though: the worker did nothing wrong, its frame merely lost a race,
 * so both legs still answer `200` (a 4xx would kill the worker over a benign reorder).
 *
 * The refusal is LOGGED, which the #201 AC requires and #39's post-mortem earned: the guard #39
 * removed answered `200` and silently discarded the frame, so an operator whose session was
 * wedged had no way to see why. A refused frame must be observable, never a silent drop — and
 * because the decision reads no clock (only two worker-supplied integers), it cannot wedge a
 * session in the first place. `level` is `warn`, not `info`: a reorder is not the steady state.
 */
function refuseStaleStatusFrame(
  state: WorkerChannelState,
  record: WorkerChannelRecord,
  sessionId: string,
  session: Session,
  sequence: number | null,
): boolean {
  if (!isStaleWorkerStatusSequence(sequence, record.highestStatusSeq)) {
    return false;
  }
  state.logger.log({
    category: "detection",
    level: "warn",
    event: "stale-frame",
    sessionId,
    // The activity the session KEEPS: a refusal is precisely the absence of a transition.
    activity: session.activity.kind,
    // Both are worker-supplied monotonic integers — no credential, nothing free-form, can ride this line.
    detail: `refused worker_status seq ${sequence} < applied ${record.highestStatusSeq}`,
  });
  return true;
}

/**
 * Advance the ordering high-water mark (#201) for a frame that was APPLIED. A frame carrying no
 * usable sequence leaves the mark alone rather than resetting it: it says nothing about order, so
 * it must not forfeit the ordering a stamped predecessor established — otherwise one unstamped
 * frame would re-open the session to every stale frame that follows.
 */
function recordStatusSequence(record: WorkerChannelRecord, sequence: number | null): void {
  if (sequence !== null && (record.highestStatusSeq === null || sequence > record.highestStatusSeq)) {
    record.highestStatusSeq = sequence;
  }
}

/**
 * Buffer the `AskUserQuestion` enrichment a §5 `input_request` frame carries (#264, #78 Option A), keyed
 * by session id, when the payload IS a well-formed one. The single seam that populates
 * {@link WorkerChannelState.requiresActionEnrichments}: a decoded relay payload is `unknown`, so it is
 * narrowed to a plain object and handed to `@ccctl/core`'s {@link requiresActionEnrichmentFromFrame} — the
 * SAME fail-closed shape guard the browser will re-read the raw frame through, which returns `null` for
 * anything that is not an `input_request` or whose payload is malformed.
 *
 * **Fail-safe toward blocking (#40 / SRV-C-002).** A malformed or non-enrichment frame buffers NOTHING and
 * touches nothing else: the `requires_action` block a `worker_status` frame set stands bare, never cleared.
 * And buffering is PURELY additive — it writes only this display map, never {@link Session.activity} — so an
 * enrichment can neither set nor clear the needs-you signal, by construction rather than by convention.
 */
function bufferInputRequestEnrichment(state: WorkerChannelState, sessionId: string, payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return;
  }
  const enrichment = requiresActionEnrichmentFromFrame(payload as ControlFrame);
  if (enrichment !== null) {
    state.requiresActionEnrichments.set(sessionId, enrichment);
  }
}

/**
 * Drop a session's buffered enrichment (#264) once it is no longer in `requires_action`. The inverse of the
 * {@link capturedRequiresActionDetail} carry-forward in `@ccctl/core`: the detail is KEPT across a
 * `requires_action` re-affirmation and lost when the session moves on, and the enrichment decorating that
 * same block follows the same lifecycle. Level-based on the RESULTING activity (reusing `@ccctl/core`'s
 * {@link isInputAwaited} predicate, never re-derived), so it holds through a re-affirmation and is a no-op
 * when nothing is buffered — `Map.delete` of an absent key. Never reads or writes {@link Session.activity},
 * so the #40 signal is untouched.
 */
function reconcileEnrichmentBuffer(state: WorkerChannelState, sessionId: string, next: Session): void {
  if (!isInputAwaited(next.activity)) {
    state.requiresActionEnrichments.delete(sessionId);
  }
}

/** Hard ceiling on a hook handoff file's byte size (#262) — pre-parse, mirroring {@link MAX_WORKER_BODY_BYTES}'s
 * role for the HTTP legs; a raw file read has no equivalent cap otherwise (security-architect consult). */
const MAX_HOOK_HANDOFF_BYTES = 1024 * 1024;

/** Best-effort delete — swallows any error (already gone, never written). Matches the hook's own fail-open stance. */
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never written (e.g. the hook never fired) — either way, nothing to report.
  }
}

/**
 * Extract the raw, UNVALIDATED `questions` value from a decoded handoff file's parsed JSON, or
 * `undefined` when it does not even have the right outer shape. Deliberately NOT validation — as with
 * `ask-user-question-hook.ts` § `extractAskUserQuestionPayload`, {@link requiresActionEnrichmentFromValue}
 * is the one place the real shape is enforced, reached via {@link bufferInputRequestEnrichment} below.
 */
function extractHandoffQuestions(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as { questions?: unknown }).questions;
}

/**
 * Read, validate, and CONSUME (delete) a hook's handoff file — the same-host local-file hand-off
 * `ask-user-question-hook.ts` writes to (#262, #78 Option A). Returns the raw, UNVALIDATED `questions`
 * value the hook captured, or `undefined` for every non-happy path: no file (the hook has not fired yet —
 * the ordinary case for a launch with no `AskUserQuestion` call), a symlink escaping the hook state
 * directory (refused before any read — see below), an oversized file, or malformed JSON. `undefined` means
 * exactly what it means everywhere else in this pipeline: "nothing captured", never an error — this
 * hand-off is decoration, and losing it must never touch the native block.
 *
 * **The symlink guard.** `ask-user-question-hook.ts`'s atomic write (temp file in the SAME directory +
 * `rename`) can only ever leave a REGULAR file at `handoffPath` — `rename(2)` replaces the destination
 * directory entry with the source's, so even a destination that used to be a symlink becomes a regular
 * file after a legitimate hook write. So a symlink found AT `handoffPath` at read time did not come from
 * the hook; something else placed it — and since the ccctl SERVER process is what eventually reads
 * whatever this resolves to (and broadcasts it, verbatim, onto the session's UI stream), an unguarded read
 * would turn a planted symlink into an arbitrary-file-read-and-leak primitive. The guard: resolve BOTH the
 * target ({@link realpathSync}`.native`) and its expected parent (the hook state directory, which
 * `installAskUserQuestionHookSettings` always creates ahead of any hook run) and require the first's
 * directory to equal the second — the same `realpathSync.native` idiom `pending-launch.ts` §
 * `resolveLaunchCwd` uses for its own launch pre-flight, applied here to a read instead of a launch. A
 * missing file (`ENOENT` — the hook has not fired yet) is the ordinary case, not a guard failure.
 */
function consumeHookHandoffQuestions(handoffPath: string): unknown {
  let resolvedPath: string;
  let resolvedDir: string;
  try {
    resolvedPath = realpathSync.native(handoffPath);
    resolvedDir = realpathSync.native(dirname(handoffPath));
  } catch {
    return undefined;
  }
  if (dirname(resolvedPath) !== resolvedDir) {
    // A symlink (or a traversal component) redirected `handoffPath` outside the hook state directory a
    // legitimate hook write can never produce — refuse to read it, but still remove the planted entry.
    unlinkQuietly(handoffPath);
    return undefined;
  }
  let size: number;
  try {
    size = statSync(resolvedPath).size;
  } catch {
    return undefined;
  }
  if (size > MAX_HOOK_HANDOFF_BYTES) {
    // Refuse BEFORE `JSON.parse` — `requiresActionEnrichmentFromValue` caps text length only AFTER
    // parsing; a raw file read has no equivalent cap otherwise.
    unlinkQuietly(handoffPath);
    return undefined;
  }
  try {
    const raw = readFileSync(resolvedPath, "utf8");
    // Strip a leading BOM (U+FEFF) explicitly by code point — `JSON.parse` rejects it otherwise.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(text);
    return extractHandoffQuestions(parsed);
  } catch {
    return undefined;
  } finally {
    // Consume-once: remove the file the moment it's been read, successfully or not, so a stale capture
    // from an earlier `AskUserQuestion` in the same long-running session can never be replayed against a
    // LATER, unrelated `requires_action` transition (the "#86 phantom decision" hazard).
    unlinkQuietly(handoffPath);
  }
}

/**
 * Correlate a hook-captured `AskUserQuestion` payload into the SAME `input_request` enrichment pipeline
 * #264 built (#262, #78 Option A) — fired exactly at the moment a `worker_status` transition is OBSERVED
 * to move a session INTO `requires_action`, on EITHER status leg (mirrors {@link reconcileNeedsInput} /
 * {@link reconcileIdleTimer}: one derivation, both legs).
 *
 * **Why here, and not on the hook's own write.** The hook (`PreToolUse`) fires BEFORE the tool executes —
 * before the corresponding `requires_action` transition even exists — so its handoff file may already sit
 * on disk well before this reconcile ever runs. Reading it eagerly (on a timer, or on file creation) would
 * correlate it to whatever `requires_action` transition happens to be current at THAT moment, which is not
 * necessarily the one it decorates — the "#86 phantom decision" staleness this codebase's docs warn about
 * elsewhere. Instead: only at the instant THIS transition is observed, stamp the capture with THIS
 * transition's own `sequence_num` (the hook itself never could — it runs before that number exists), so
 * the enrichment is tied to the exact block it decorates.
 *
 * A transition to any OTHER activity (including a re-affirmed `requires_action`) is a no-op — the guard
 * fires only on a prior-NOT-awaited → next-awaited edge, the same transition shape
 * {@link reconcileNeedsInput} keys on. No `hookInstalls` entry for this session (a launch whose hook
 * install failed and degraded, or a test fixture that never wires one) is ALSO a no-op. Either way,
 * {@link consumeHookHandoffQuestions} returning `undefined` (no fresh capture) is the ordinary case, not
 * an error, and this function does nothing further.
 *
 * The synthesized frame is fed through the EXISTING #264 pipeline ({@link bufferInputRequestEnrichment})
 * rather than duplicating its validation: this function's entire job is producing a well-formed
 * `input_request`-shaped {@link ControlFrame} stamped with a REAL `sequence_num` — every
 * length/cardinality/shape guard from #261's `requiresActionEnrichmentFromValue` still applies exactly as
 * it does to a worker-emitted frame.
 */
function reconcileHookHandoff(
  state: WorkerChannelState,
  sessionId: string,
  prior: Session,
  next: Session,
  sequence: number | null,
): void {
  if (isInputAwaited(prior.activity) || !isInputAwaited(next.activity) || sequence === null) {
    return;
  }
  const install = state.hookInstalls.get(sessionId);
  if (install === undefined) {
    return;
  }
  const questions = consumeHookHandoffQuestions(install.handoffPath);
  if (questions === undefined) {
    return;
  }
  const frame: ControlFrame = {
    type: "control_event",
    subtype: "input_request",
    payload: { sequence_num: sequence, questions },
  };
  bufferInputRequestEnrichment(state, sessionId, frame);
}

/**
 * Fold a §5 payload into the session's classification when it is a `worker_status` frame
 * (#39). This is the leg that carries the RICH frame — `payload: { status, detail }` — so it
 * is the ONLY place the human-ready tool description enters the session model; the §4 gate
 * ({@link handleWorkerStatus}) reports a bare status with no detail field at all.
 *
 * Additive to the verbatim relay, never a substitute: the UI decodes the same frame itself to
 * render the in-place current-turn indicator (#15), so what IS relayed stays byte-identical.
 *
 * Returns whether the frame was REFUSED by the ordering guard (#201) — `true` tells
 * {@link handleWorkerEvents} to drop it from the relay too, so BOTH the session model and the
 * browser skip it. "Verbatim" governs the FIDELITY of a relayed frame, never an obligation to
 * relay one the server has already ruled out: a `worker_status` is the only payload the UI does
 * not append to its transcript — it renders it IN PLACE as the session's live current turn
 * (`transcript.js`'s `{ kind: "activity" }`; `formatTranscriptEntry` is explicitly for
 * NON-`worker_status` events). So a stale frame relayed anyway is not history preserved, it is a
 * LIVE CLAIM the server has just adjudicated false — "Running…" rendered over a session blocked on
 * the operator, with no later frame coming to correct it (it is blocked precisely because it is
 * waiting). Dropping it also keeps ONE adjudicator: the browser needs no mirrored high-water mark,
 * and cannot reach a verdict the server has rejected.
 *
 * Fail-soft, matching the batch contract: {@link applyWorkerStatusFrame} returns the session
 * unchanged for any payload that is not a well-formed `worker_status` (a transcript line, an
 * unknown status, a scalar), so a non-status entry is simply a no-op here — and, carrying no
 * sequence, is never refusable, so the relay below always gets it.
 */
function foldWorkerStatus(
  state: WorkerChannelState,
  record: WorkerChannelRecord,
  sessionId: string,
  payload: unknown,
): boolean {
  // A relayed payload is whatever the worker sent, so it is read back as `unknown` and narrowed
  // to a plain object before the cast — the same stance `decodeControlFrame` takes over a
  // decoded line. `applyWorkerStatusFrame`'s own guard does the rest of the validation.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return false;
  }
  const frame = payload as ControlFrame;
  // The ordering guard (#201) — before the fold, so a stale frame moves nothing. Scoped to frames
  // that ARE a well-formed `worker_status`: `workerStatusSequenceFromFrame` yields `null` for
  // anything else, and a `null` sequence is never stale, so a transcript line still no-ops below.
  const sequence = workerStatusSequenceFromFrame(frame);
  if (refuseStaleStatusFrame(state, record, sessionId, session, sequence)) {
    return true;
  }
  // Advance the mark for the frame we are about to apply — kept beside the guard it pairs with,
  // rather than inside the `next !== session` branch below, so the ordering decision and its
  // bookkeeping read as one unit and neither depends on another function's return identity.
  recordStatusSequence(record, sequence);
  const next = applyWorkerStatusFrame(session, frame);
  if (next !== session) {
    state.sessions.set(sessionId, next);
    // Detection trail (#61): the §5 leg observed a worker_status transition.
    logActivityTransition(state, sessionId, session, next);
    // A worker_status was observed (#41): arm the idle timer on a move INTO idle, clear it on any move
    // off idle. `applyWorkerStatusFrame` returns a NEW session for every well-formed worker_status
    // frame (it advances `lastActivityAt`), so `next !== session` is exactly "a status frame applied";
    // a non-status payload leaves the session untouched and rightly skips the reconcile.
    reconcileIdleTimer(state, sessionId, next);
    // The blocking sibling (#43): raise the "needs input" notification on a transition INTO
    // `requires_action`. `session` is the PRIOR state, so the transition is decided against it.
    reconcileNeedsInput(state, sessionId, session, next);
    // Drop the buffered enrichment (#264) when the session leaves `requires_action` — the decorated block
    // is gone, so its question must not be re-served against whatever it moved to. A no-op while the block
    // persists (a re-affirmation) and when there is nothing buffered.
    reconcileEnrichmentBuffer(state, sessionId, next);
    // ... and correlate a hook-captured `AskUserQuestion` payload (#262) on the SAME transition INTO
    // `requires_action` this reconcile family already keys on — one derivation, one more consumer.
    reconcileHookHandoff(state, sessionId, session, next, sequence);
  }
  return false;
}

/**
 * `POST …/worker/events` (§5). The upstream transcript leg: a batched
 * `{ worker_epoch, events: [{ payload }] }`. Each payload is a raw `stream-json`
 * message the server relays to the UI SSE (#13) — this is where a turn's output
 * returns — and a `worker_status` payload ALSO feeds the session's classification
 * ({@link foldWorkerStatus}, #39). Fails closed 404 (unknown session), 409 (superseded
 * epoch), or 400 (malformed body). MUST `200` on success.
 */
export function handleWorkerEvents(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "POST", (record, body) => {
    const events = body.events;
    if (!Array.isArray(events)) {
      writeError(res, 400, "ccctl: worker-events body `events` must be an array");
      return;
    }
    for (const entry of events) {
      // Relay each event's payload verbatim to THIS SESSION's UI stream (#20: never to
      // another session's subscribers). A malformed entry (no `payload`) is skipped rather
      // than tearing down the batch — fail-soft per event, fail-closed only on the batch
      // envelope above.
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && "payload" in entry) {
        const { payload } = entry as { payload: JsonValue };
        // Entries in one batch apply in order, so a batch carrying running→idle lands on idle.
        // A frame the ordering guard refused (#201) is dropped from the relay too, for the reason
        // {@link foldWorkerStatus} pins; everything else relays verbatim (#13/#15).
        const refused = foldWorkerStatus(state, record, sessionId, payload);
        if (!refused) {
          // Buffer an `input_request` enrichment (#264) ALONGSIDE the verbatim relay, never as a
          // substitute: `foldWorkerStatus` already no-op'd on this non-`worker_status` frame (the session
          // model is untouched), and the browser still decodes the raw frame off the relay. This only
          // retains the decoration so the per-session READ can serve it to a UI that connected afterwards.
          bufferInputRequestEnrichment(state, sessionId, payload);
          broadcastEvent(state.eventRelays, sessionId, payload);
        }
      }
    }
    writeJson(res, 200, {});
  });
}

/**
 * `PUT …/worker` (§4). The status gate: `{ worker_status, worker_epoch,
 * external_metadata, sequence_num }`. Derives the session's `activity` from `worker_status`
 * ({@link applyWorkerStatus}) — `idle` means "ready for a turn" — unless the optional
 * `sequence_num` proves the frame stale ({@link refuseStaleStatusFrame}, #201), which is a
 * `200` too. Fails closed 404 (unknown session), 409 (superseded epoch), or 400 (unknown
 * `worker_status`, drift). MUST `200` on success or the worker exits.
 */
export function handleWorkerStatus(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "PUT", (record, body) => {
    const workerStatus = body.worker_status;
    if (!isWorkerStatus(workerStatus)) {
      writeError(res, 400, "ccctl: worker-status body carries an unknown `worker_status` (drift)");
      return;
    }
    // The ordering signal (#201) rides this leg at the body's top level, beside the bare status it
    // orders — the §5 leg carries the same field inside the frame's payload, beside ITS status.
    const sequence = asWorkerStatusSequence(body.sequence_num);
    const session = state.sessions.get(sessionId);
    // A stale frame is refused BEFORE the apply — no transition, no reconcile — but still answers
    // 200 below: it is not the worker's error, and a 4xx here would kill it over a benign reorder.
    if (session !== undefined && !refuseStaleStatusFrame(state, record, sessionId, session, sequence)) {
      recordStatusSequence(record, sequence);
      const next = applyWorkerStatus(session, workerStatus);
      state.sessions.set(sessionId, next);
      // Detection trail (#61): the §4 gate observed a worker_status transition — same derivation as §5.
      logActivityTransition(state, sessionId, session, next);
      // The §4 gate is the other place `idle` is observed (#41) — reconcile the idle timer off the
      // resulting activity exactly as the §5 leg does, so one derivation governs both legs.
      reconcileIdleTimer(state, sessionId, next);
      // ... and the same for the blocking needs-input notification (#43): one derivation, both legs.
      // `session` is the PRIOR state, so a bare `requires_action` re-affirmation is not a transition.
      reconcileNeedsInput(state, sessionId, session, next);
      // ... and drop the buffered enrichment (#264) if this bare status moved the session off
      // `requires_action` — one derivation governs both legs, exactly as the reconciles above.
      reconcileEnrichmentBuffer(state, sessionId, next);
      // ... and the same hook-handoff correlation (#262) — one derivation, both legs, exactly as the
      // reconciles above.
      reconcileHookHandoff(state, sessionId, session, next, sequence);
    }
    writeJson(res, 200, {});
  });
}

/**
 * `GET …/worker` (§4 worker-state restore, issue #154). The bare `…/worker` path is
 * method-multiplexed: `PUT` is the status gate ({@link handleWorkerStatus}); `GET` —
 * the child's worker-state restore — previously 405'd (the path was PUT-only) and the
 * child retried in a loop. It answers an empty `200`: `{ worker: null }` when the
 * server holds no restorable worker state (its steady state at this slice —
 * `external_metadata` / `internal_metadata` are read off the `PUT` status body but not
 * persisted, so there is nothing to restore), or, once such state IS tracked,
 * `{ worker: { external_metadata, internal_metadata } }`. Fails closed `404` for an
 * unknown session, `409` for one that has not registered over the bridge yet
 * ({@link rejectIfRegistering}), `405` for a non-GET (defensive — the router sends GET here).
 */
export function handleWorkerStateRestore(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-state-restore path`);
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  if (rejectIfRegistering(res, session, sessionId)) {
    return;
  }
  // No restorable worker state is persisted at this slice, so this is always the empty
  // `{ worker: null }` form — the "nothing to restore" envelope the worker tolerates.
  writeJson(res, 200, { worker: null });
}

/**
 * `POST …/worker/heartbeat` (§4). Liveness: refreshes the session's
 * `lastActivityAt` ({@link recordHeartbeat}). The body is not load-bearing (drained,
 * ignored) — liveness must stay robust, so it is not epoch-gated. Fails closed
 * 404/405 for an unknown session / wrong method, and 409 for one that has not registered
 * over the bridge yet ({@link rejectIfRegistering}) — a `registering` session has no worker
 * that could legitimately be heartbeating it. MUST `200` otherwise.
 */
export function handleWorkerHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker-heartbeat path`);
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  if (rejectIfRegistering(res, session, sessionId)) {
    return;
  }
  req.resume(); // drain the (ignorable) body.
  state.sessions.set(sessionId, recordHeartbeat(session));
  writeJson(res, 200, {});
}

/**
 * `POST …/worker/events/delivery` (§5). The worker's per-event downstream acks:
 * `{ worker_epoch, updates: [{ event_id, status }] }`. Accepted (this slice has no
 * redelivery / visibility-timeout, so the acks are a no-op beyond validation). Fails
 * closed 404 (unknown session), 409 (superseded epoch), or 400 (malformed body).
 * MUST `200`.
 */
export function handleWorkerDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
): void {
  readWorkerBody(req, res, state, sessionId, "POST", (_record, body) => {
    if (!Array.isArray(body.updates)) {
      writeError(res, 400, "ccctl: worker-delivery body `updates` must be an array");
      return;
    }
    writeJson(res, 200, {});
  });
}

/**
 * Inject one user turn — push a `{ type: "user" }` `client_event` down the session's
 * held-open downstream (§4/§5 turn injection). The `--sdk-url` worker demuxes on
 * `payload.type`, so a user prompt is a `user` message. Fails closed (throws) when
 * the session has no live downstream — the UI-facing caller ({@link injectTurn})
 * surfaces that.
 */
export function injectUserTurn(state: WorkerChannelState, sessionId: string, prompt: string): void {
  const payload: JsonValue = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
  pushClientEvent(state, sessionId, payload);
}

/**
 * Relay one UI steer worker-ward — push the {@link ControlRequest} as the payload of
 * a `client_event` down the session's held-open downstream. `request.type` is
 * `"control_request"`, one of the demux types the worker reads. Fails closed
 * (throws) when the session has no live downstream, the same as {@link injectUserTurn}.
 */
export function dispatchControlRequest(state: WorkerChannelState, sessionId: string, request: ControlRequest): void {
  pushClientEvent(state, sessionId, request as unknown as JsonValue);
}

/**
 * Whether the session has a LIVE worker channel — a worker that registered AND is
 * holding its §4/§5 downstream open. This is exactly {@link injectUserTurn}'s
 * precondition: `true` iff a `client_event` push would NOT fail closed (`record`
 * present with a non-null `downstream`). The receiver-grounded read of "a real worker
 * is connected", distinct from the session merely existing; `false` for an unknown
 * session or one whose worker has not opened (or has closed) its downstream.
 */
export function hasLiveWorkerChannel(state: WorkerChannelState, sessionId: string): boolean {
  const record = state.workerChannels.get(sessionId);
  return record !== undefined && record.downstream !== null;
}

/**
 * End every held-open worker downstream and clear it — called from server shutdown.
 * A held-open SSE response keeps its connection open indefinitely, so
 * `httpServer.close()` would otherwise hang waiting on it (the UI-stream analog in
 * `event-stream.ts`).
 */
export function closeWorkerChannels(state: WorkerChannelState): void {
  for (const record of state.workerChannels.values()) {
    endDownstream(record);
    record.downstream = null;
  }
}

// --- internals ---

/**
 * The inert payload of a **liveness frame** (#166) — a well-formed `client_event` the worker
 * counts toward downstream liveness (it is the SSE event NAME, `client_event`, that resets the
 * worker's ~45s timeout) yet demuxes to nothing: `type` is NOT one of the worker's demux
 * discriminants (`user` / `control_request` / `control_response`), so no turn is injected and no
 * control action runs. Being a DOWNSTREAM push it also never rides the upstream `worker/events`
 * transcript leg, so nothing is surfaced to the UI and `worker_status` is untouched — the frame
 * is a no-op beyond keeping the stream alive.
 *
 * The namespaced `type` avoids collision with any real worker payload. Worker-side inertness is
 * proven end-to-end against a real worker by the #167 e2e follow-up; here it is a no-op by
 * construction on the server side (asserted in worker-channel.test.ts).
 */
const LIVENESS_PAYLOAD: JsonValue = { type: "ccctl_liveness" };

/**
 * Write one `client_event` frame down a record's live downstream per §4/§5 — event name pinned,
 * `data` the demux envelope — consuming a monotonic `sequence_num` so the worker sees a gap-free
 * stream. A `null` downstream is a silent no-op; each caller gates that per its own contract
 * ({@link pushClientEvent} throws first; {@link writeLivenessFrame} guards first).
 */
function writeClientEventFrame(record: WorkerChannelRecord, payload: JsonValue): void {
  const { downstream } = record;
  if (downstream === null) {
    return;
  }
  const seq = record.nextSeq++;
  const data = JSON.stringify({ sequence_num: seq, event_id: randomUUID(), event_type: "message", payload });
  downstream.write(`event: client_event\nid: ${seq}\ndata: ${data}\n\n`);
}

/**
 * Push one `client_event` down the session's held-open downstream (turn injection / steer). Fails
 * closed (throws) when the session has no live downstream — the UI-facing callers surface that.
 */
function pushClientEvent(state: WorkerChannelState, sessionId: string, payload: JsonValue): void {
  const record = state.workerChannels.get(sessionId);
  if (record === undefined || record.downstream === null) {
    throw new Error(`ccctl: no live worker channel for session ${sessionId}`);
  }
  // A turn / steer pushed at the operator's hand is ACTIVITY (#41 AC3 "a new turn … resets the timer"):
  // reset the idle clock now rather than wait for the worker's echoing status change, so an actively-
  // driven session never trips the "idle > X" nudge in the gap. The no-op liveness frame is NOT a turn —
  // it reaches {@link writeClientEventFrame} directly, never here, so it rightly leaves the timer running.
  clearIdleTimer(record);
  writeClientEventFrame(record, payload);
}

/**
 * Write one no-op {@link LIVENESS_PAYLOAD} `client_event` (#166) — but ONLY if `res` is still the
 * record's live, writable downstream. Guards (never throws) so a fired-but-stale interval can
 * never write to a reaped/ended stream; unlike {@link pushClientEvent} an absent/mismatched
 * downstream is a silent no-op, not an error.
 */
function writeLivenessFrame(record: WorkerChannelRecord, res: ServerResponse): void {
  if (record.downstream !== res || res.writableEnded) {
    return;
  }
  writeClientEventFrame(record, LIVENESS_PAYLOAD);
}

/**
 * Clear a record's armed liveness interval, if any, and null the field. Idempotent — safe on a
 * record whose timer is already null or already cleared (supersede + a later stream-close both
 * reach it).
 */
function clearLivenessTimer(record: WorkerChannelRecord): void {
  if (record.livenessTimer !== null) {
    clearInterval(record.livenessTimer);
    record.livenessTimer = null;
  }
}

/**
 * Clear a record's armed grace-delayed eviction check (#173), if any, and null the field.
 * Idempotent — safe on a record with no pending eviction. Routed through {@link endDownstream} so a
 * reconnect (re-register / reopen) or shutdown cancels a pending eviction the SAME way it tears the
 * downstream down — a returning worker's session is never evicted out from under it.
 */
function clearEvictionTimer(record: WorkerChannelRecord): void {
  if (record.evictionTimer !== null) {
    clearTimeout(record.evictionTimer);
    record.evictionTimer = null;
  }
}

/**
 * Clear a record's armed idle-threshold check (#41), if any, and null the field. Idempotent — safe on a
 * record whose idle timer is already null (a move off idle, a turn injection, and a downstream teardown
 * can each reach it). The counterpart of {@link armIdleTimer}: together the only two writers of
 * {@link WorkerChannelRecord.idleTimer}.
 */
function clearIdleTimer(record: WorkerChannelRecord): void {
  if (record.idleTimer !== null) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
}

/**
 * Arm the per-session idle-threshold check (#41) — but ONLY if one is not already armed. A one-shot
 * fires {@link WorkerChannelState.sessionIdleThresholdMs} later and calls {@link fireIdleEvent}. The
 * "arm only when null" guard is what makes this measure ONE continuous idle stretch: a redundant `idle`
 * re-affirmation (the worker re-`PUT`s idle, or another idle §5 frame lands) finds the timer already
 * armed and leaves it running rather than restarting the clock — otherwise a heart-beating idle session
 * re-affirming idle every few seconds would never reach the threshold. `.unref()` so a pending check
 * alone never blocks process exit, matching the sibling liveness / eviction timers.
 */
function armIdleTimer(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  if (record.idleTimer !== null) {
    return;
  }
  const timer = setTimeout(() => {
    fireIdleEvent(state, sessionId, record);
  }, state.sessionIdleThresholdMs);
  timer.unref();
  record.idleTimer = timer;
}

/**
 * Reconcile a session's idle-threshold timer against its just-applied {@link Session.activity} (#41) —
 * the single seam both the §4 status gate ({@link handleWorkerStatus}) and the §5 events leg
 * ({@link foldWorkerStatus}) route their observed status through, so "arm on idle, reset off idle" holds
 * once for both legs. Idle → arm (via {@link armIdleTimer}, a no-op when already counting); any other
 * activity (`running` / `requires_action`) → clear, which IS AC3's "a status change resets the timer".
 * A no-op when the session has no channel record — the status legs cannot reach here without one (their
 * epoch gate requires it), so this only guards a torn-down race.
 */
function reconcileIdleTimer(state: WorkerChannelState, sessionId: string, session: Session): void {
  const record = state.workerChannels.get(sessionId);
  if (record === undefined) {
    return;
  }
  if (session.activity.kind === "idle") {
    armIdleTimer(state, sessionId, record);
  } else {
    clearIdleTimer(record);
  }
}

/**
 * Raise the blocking "needs input" notification (#43) when a session TRANSITIONS into `requires_action`
 * — the single seam both the §4 status gate ({@link handleWorkerStatus}) and the §5 events leg
 * ({@link foldWorkerStatus}) route their observed status through, so "notify on the move into awaiting"
 * holds once for both legs, exactly as {@link reconcileIdleTimer} does for idle. Composes the canonical
 * needs-you trigger (`@ccctl/core` {@link isInputAwaited}) — reused, never re-derived — with two more
 * dimensions the single-DIMENSION trigger deliberately does not see:
 *
 *   - **TRANSITION, not level.** Emits only on the move INTO `requires_action` (`prev` was NOT already
 *     awaiting), so a §4 bare re-affirmation of `requires_action`, or a redundant §5 frame, never
 *     re-notifies. The blocking analogue of the idle timer's arm-once "one continuous stretch" guard: a
 *     session sitting in `requires_action` is one blocking event, not one per frame.
 *   - **LIVENESS.** "Needs input" means awaiting AND alive — a heartbeat-stale awaiter is eviction's job
 *     (#173), not a nudge, so a `requires_action` whose heartbeat has lapsed is suppressed
 *     ({@link isSessionStale}, the same {@link WorkerChannelState.sessionEvictionGraceMs} staleness
 *     window {@link fireIdleEvent} uses — one rule governs both).
 *
 * The LIFECYCLE half of the composition (`@ccctl/core` § `isInputAwaited`: a session gone *closed* must
 * not notify) needs no explicit check here — a closed / stopped / evicted session is DELETED from the
 * registry (`session-close.ts` § `closeSession`), so the caller's `session !== undefined` guard plus
 * this seam's synchronous execution mean a closed session can never reach the emit. The same
 * registry-absence invariant {@link fireIdleEvent} leans on (`session === undefined` → nothing to nudge).
 *
 * Broadcast onto the session's OWN per-session relay (#20), so it inherently reaches only that session's
 * subscribers and NAMES the session in the payload besides — the unambiguous identification the AC asks
 * for, never a generic "a session needs you".
 */
function reconcileNeedsInput(state: WorkerChannelState, sessionId: string, prev: Session, next: Session): void {
  if (isInputAwaited(prev.activity)) {
    return; // already awaiting — a re-affirmation, not a fresh transition; do not re-notify.
  }
  const { activity } = next;
  if (!isInputAwaited(activity)) {
    return; // did not enter the blocking needs-you state.
  }
  if (isSessionStale(next, Date.now(), state.sessionEvictionGraceMs)) {
    return; // awaiting but heartbeat-stale — eviction's job (#173), not a nudge.
  }
  // Notification trail (#61/#43): the blocking needs-you, named to the session, is being dispatched.
  state.logger.log({
    category: "notification",
    level: "warn",
    event: "awaiting-input",
    sessionId,
    detail: activity.detail,
  });
  broadcastEvent(state.eventRelays, sessionId, needsInputEvent(sessionId, activity.detail));
}

/**
 * Fire the "idle > X" informational event (#41): the one-shot armed by {@link armIdleTimer} has elapsed,
 * so raise the event naming the session onto its UI stream — but only if it is STILL genuinely idle and
 * alive. Nulls the field first (the one-shot is spent), then fails closed on each way the world may have
 * moved during the wait:
 *   - a re-register swapped in a fresh channel record — this stale closure is not the session's current
 *     timer, so it bows out and lets the new registration own the lifecycle;
 *   - the session was evicted / stopped — its row is gone, so there is nothing to nudge (and a broadcast
 *     would lazily resurrect a relay for a session that no longer exists);
 *   - it already left idle — a status change that raced the fire; the reset it should have caused wins;
 *   - it has gone STALE — no heartbeat within the window ({@link isSessionStale}). This is the
 *     "+ heartbeat" half of the AC: "idle > X" means idle AND alive; a silent-then-idle worker is
 *     eviction's job (#173), not something to nudge as though it were sitting ready. The window reuses
 *     {@link WorkerChannelState.sessionEvictionGraceMs} so ONE staleness rule governs both.
 * Only a session clearing all four gets the event, broadcast onto its own per-session relay (#20) — so
 * it inherently reaches only that session's subscribers, and names the session in the payload besides.
 */
function fireIdleEvent(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  record.idleTimer = null; // the one-shot has fired.
  if (state.workerChannels.get(sessionId) !== record) {
    return; // superseded by a re-register — not this session's current timer.
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return; // evicted / stopped while idle — nothing to nudge.
  }
  if (session.activity.kind !== "idle") {
    return; // moved off idle in a race with the fire — the reset wins.
  }
  if (isSessionStale(session, Date.now(), state.sessionEvictionGraceMs)) {
    return; // idle but no longer heart-beating — eviction's job, not a nudge.
  }
  // Notification trail (#61/#41): the informational idle nudge, named to the session, is being dispatched.
  state.logger.log({
    category: "notification",
    level: "info",
    event: "idle",
    sessionId,
    detail: `idle > ${String(state.sessionIdleThresholdMs)}ms`,
  });
  broadcastEvent(state.eventRelays, sessionId, idleEvent(sessionId, state.sessionIdleThresholdMs));
}

/**
 * The "idle > X" informational event payload (#41): a {@link SESSION_IDLE_EVENT_TYPE}-typed object that
 * NAMES the session (AC2) and carries the threshold it crossed, self-describing so a consumer needs no
 * out-of-band context. Marked {@link INFORMATIONAL_NOTIFICATION} (#44): a consumer reads the spread-in
 * `notification_class` / `urgency` / `renudge` / `batchable` fields to handle it as quiet + batchable +
 * never-re-nudged, WITHOUT re-deriving urgency from the `type`. A {@link JsonValue}, so it rides the same
 * per-session UI relay as a verbatim worker payload.
 */
function idleEvent(sessionId: string, thresholdMs: number): JsonValue {
  return {
    type: SESSION_IDLE_EVENT_TYPE,
    session_id: sessionId,
    idle_threshold_ms: thresholdMs,
    ...INFORMATIONAL_NOTIFICATION,
  };
}

/**
 * The blocking "needs input" notification payload (#43): a {@link SESSION_NEEDS_INPUT_EVENT_TYPE}-typed
 * object that NAMES the session (AC1/AC3) and carries the human-ready `detail` the `requires_action`
 * frame captured — already normalized to one bounded, displayable line at the core model boundary
 * (`@ccctl/core` § `displayableDetail`: zero-width / control characters stripped, clamped to
 * `MAX_REQUIRES_ACTION_DETAIL_LENGTH`), so the notification inherits that guarantee rather than
 * re-sanitizing worker-supplied text here. Marked {@link BLOCKING_NOTIFICATION} (#44): a consumer reads
 * the spread-in `notification_class` / `urgency` / `renudge` / `batchable` fields to handle it as
 * high-urgency + re-nudgeable + never batched. A {@link JsonValue}, so it rides the same per-session UI
 * relay as a verbatim worker payload — the blocking sibling of {@link idleEvent}, discriminated by its
 * `type` AND, one level up, by its firewalled `notification_class`.
 */
function needsInputEvent(sessionId: string, detail: string): JsonValue {
  return {
    type: SESSION_NEEDS_INPUT_EVENT_TYPE,
    session_id: sessionId,
    detail,
    ...BLOCKING_NOTIFICATION,
  };
}

/**
 * End a record's held-open downstream and clear ALL its armed timers — the liveness interval (#166),
 * any pending eviction check (#173), AND any armed idle-threshold check (#41) — the single teardown
 * every downstream-ending path routes through: a supersede (a re-register in
 * {@link handleWorkerRegister}, a duplicate open in {@link handleWorkerEventsStream}), a channel reap
 * ({@link reapWorkerChannel}, the eviction + emergency-stop paths), and shutdown
 * ({@link closeWorkerChannels}). Ending the stream and clearing its timers are kept inseparable here so
 * no new downstream inherits a stale interval, no timer is left to dangle, a reconnect cancels a pending
 * eviction, and a reaped session can never fire an "idle > X" event onto a relay that is being torn
 * down. Leaves `record.downstream` set for the caller to null or reassign.
 */
function endDownstream(record: WorkerChannelRecord): void {
  clearLivenessTimer(record);
  clearEvictionTimer(record);
  clearIdleTimer(record);
  if (record.downstream !== null) {
    record.downstream.end();
  }
}

/**
 * Arm the grace-delayed eviction check (#173) for a record whose downstream just went null. The
 * one-shot fires after {@link WorkerChannelState.sessionEvictionGraceMs}; `.unref()` so a pending
 * check alone never blocks process exit. Stored on {@link WorkerChannelRecord.evictionTimer} so a
 * reconnect / reopen / shutdown clears it through {@link endDownstream}. Re-armed by
 * {@link considerEviction} while a beating-but-downstream-less worker keeps the session alive.
 */
function scheduleEviction(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  const timer = setTimeout(() => {
    considerEviction(state, sessionId, record);
  }, state.sessionEvictionGraceMs);
  timer.unref();
  record.evictionTimer = timer;
}

/**
 * REAP a session's worker channel — end its held-open downstream, clear its armed timers, drop the
 * record. The ONE place a channel leaves {@link WorkerChannelReapState.workerChannels} while the
 * server is still running.
 *
 * Two paths retire a channel, and until #76 there was one: the grace-delayed eviction
 * ({@link considerEviction}) that fires when a worker is terminally gone. The operator's
 * emergency-stop (`ui-session-stop.ts`) is the second, and it does not arrive through that timer at
 * all — it arrives having ALREADY dropped the session's row through `session-close.ts`. That ordering
 * is precisely what makes a second copy of these two lines a trap rather than a duplication: the
 * eviction check bails the moment the row is gone (`state.sessions.get(sessionId) === undefined` — "a
 * prior pass already evicted it"), so a stopped session's channel is the one channel that timer can
 * NEVER come back and finish. Whatever a stop does not reap here is never reaped at all, and this
 * module's "the registry does not grow unbounded across worker exits" promise quietly stops holding —
 * one inert record per stopped session, each still holding whatever downstream and timers it had.
 *
 * Idempotent, and a no-op for a session that never registered a worker — the ordinary case for a stop,
 * which can be handed a session still `registering`.
 *
 * Lives HERE rather than in `session-close.ts` beside the row-and-relay teardown, where it would read
 * more naturally as one terminal seam: that module would have to import {@link endDownstream}, and this
 * one already imports {@link closeSession} from it — a cycle. The channel registry is this module's
 * state, so the seam that empties it stays with it and the terminal seam calls out to it.
 */
export function reapWorkerChannel(state: WorkerChannelReapState, sessionId: string): void {
  const record = state.workerChannels.get(sessionId);
  if (record === undefined) {
    return;
  }
  // Canonical record teardown — ends the downstream and clears any residual timers before dropping it,
  // so nothing is left armed against a record nobody holds.
  endDownstream(record);
  state.workerChannels.delete(sessionId);
}

/**
 * The grace-delayed eviction DECISION (#173): CLOSE + evict a terminally-gone session, RETAIN a
 * transiently-reconnecting or still-beating one. Fires one grace window after the downstream went
 * null ({@link scheduleEviction}). Evicts ONLY when ALL of the following hold — otherwise it
 * retains (re-arming when the worker is merely beating without a downstream, so a later silence is
 * still caught):
 *   - the record is still the session's CURRENT channel — a re-register swapped in a fresh record,
 *     so this stale closure bails and lets the new registration own the session's lifecycle;
 *   - the downstream is still null — a reopened downstream means the worker is back → retain;
 *   - the session still exists — a prior pass already evicted it → nothing to do;
 *   - the session is STALE — no heartbeat within the grace window ({@link isSessionStale}). A fresh
 *     heartbeat means the worker is alive though its downstream dropped, so a null downstream ALONE
 *     never evicts (the reconnect-safety AC).
 * On eviction it ENDS the session through the one terminal seam ({@link closeSession},
 * `session-close.ts` — the reverse leg of #172's `connecting`→`ready`: terminal status, row dropped,
 * relay reaped) and reaps its worker channel through the one reap seam ({@link reapWorkerChannel}), so
 * `GET /api/sessions` ("`ccctl attach`") stops listing it and the registry does not grow unbounded
 * across worker exits.
 *
 * Both seams were extracted in #76, when the operator's emergency-stop became the SECOND path that
 * ends a session — and each extraction surfaced a bug the duplication had been hiding. The terminal
 * transition here used to `set` the closed session and `delete` it on the very next line, so the
 * status was computed and thrown away against a `Map` nothing observes: it READ as a transition and
 * was not one. The channel teardown was the mirror image — correct here, and unreachable from the stop
 * path, because this check bails on a row the stop has already dropped (see {@link reapWorkerChannel}).
 * Both seams return the caller to one copy of the sequence; `closeSession`'s return value is ignored
 * here, correctly, since an eviction timer has nobody to answer and the reflection a client gets is the
 * one it always was (the row leaves the list, the stream ends).
 */
function considerEviction(state: WorkerChannelState, sessionId: string, record: WorkerChannelRecord): void {
  record.evictionTimer = null; // this one-shot has fired.
  // A re-register replaced the record: this closure is stale — the fresh registration owns the
  // session now, so never let it evict a reconnected session.
  if (state.workerChannels.get(sessionId) !== record) {
    return;
  }
  // The worker reopened its downstream — it is back. Retain.
  if (record.downstream !== null) {
    return;
  }
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return;
  }
  // Downstream still null but the worker is still heart-beating — alive, just without a downstream.
  // A null downstream alone must NOT evict (#173): retain, and re-check after another grace window
  // so a subsequent silence is still caught.
  if (!isSessionStale(session, Date.now(), state.sessionEvictionGraceMs)) {
    scheduleEviction(state, sessionId, record);
    return;
  }
  // Detection trail (#61): the session went silent — no downstream and no heartbeat for a full grace
  // window — so it is stale and about to be reaped. Naming the stall HERE, right before closeSession
  // logs the death, is what makes a stalled-then-evicted daemon diagnosable rather than a bare `closed`.
  state.logger.log({
    category: "detection",
    level: "warn",
    event: "stale",
    sessionId,
    activity: session.activity.kind,
    detail: `no downstream + heartbeat gap > ${String(state.sessionEvictionGraceMs)}ms — evicting`,
  });
  // Terminally gone: no downstream and no heartbeat for a full grace window. END the session through
  // the one terminal seam — terminal status, row dropped so `GET /api/sessions` ("ccctl attach") stops
  // listing it, relay reaped (#176) so it does not accumulate across evictions — then reap its channel
  // through the one reap seam. The returned closed session is ignored: nobody is waiting on this timer
  // to be told what it became (`session-close.ts`).
  closeSession(state, sessionId);
  reapWorkerChannel(state, sessionId);
}

/**
 * Read + epoch-validate an upstream worker POST body, then invoke `onBody` with the
 * live {@link WorkerChannelRecord} and the parsed object. Centralizes the shared
 * fail-closed tail of the `events` / `status` / `delivery` legs: wrong method → 405,
 * unknown session → 404, unregistered / superseded epoch → 409, non-object or
 * over-cap body → 400/413. Only a request that clears all of these reaches `onBody`.
 */
function readWorkerBody(
  req: IncomingMessage,
  res: ServerResponse,
  state: WorkerChannelState,
  sessionId: string,
  method: "POST" | "PUT",
  onBody: (record: WorkerChannelRecord, body: Record<string, unknown>) => void,
): void {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on the worker channel`);
    return;
  }
  if (!state.sessions.has(sessionId)) {
    writeError(res, 404, `ccctl: no session ${sessionId}`);
    return;
  }
  void readJsonBody(req, MAX_WORKER_BODY_BYTES).then((result) => {
    if (!result.ok) {
      writeError(res, result.status, result.message);
      return;
    }
    if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
      writeError(res, 400, "ccctl: worker channel body must be a JSON object");
      return;
    }
    const body = result.value as Record<string, unknown>;
    const record = state.workerChannels.get(sessionId);
    // The epoch gate: the worker must have registered, and the stamped epoch must be
    // the current one. A superseded (or absent) epoch fails closed 409 — the worker exits.
    if (record === undefined || body.worker_epoch !== record.epoch) {
      writeError(res, 409, `ccctl: worker channel epoch superseded for session ${sessionId}`);
      return;
    }
    onBody(record, body);
  });
}
