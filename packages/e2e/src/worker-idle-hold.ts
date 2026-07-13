// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The hermetic **idle-hold** regression — the deterministic complement that verifies the
 * server's #166 downstream-liveness fix END-TO-END, without a real worker or credentials
 * (issue #167).
 *
 * The captured-wire golden (`bridge-wire-conformance.ts`, #131/#155) pins the SHAPE and
 * STATUS of each bridge leg, but not that the server **holds the worker downstream SSE
 * alive over time**. A server that opens `…/worker/events/stream` and then lets it go
 * silent passes the golden — every leg's shape is right — yet fails a real worker, which
 * enforces a **~45s downstream-liveness timeout** on that stream and, counting ONLY real
 * `client_event` frames toward it, reconnect-loops (`connect → liveness-timeout →
 * reconnect`) on an idle session. #166 fixes that with a per-session timer emitting a no-op
 * `client_event` liveness frame below the timeout; this is the regression that proves it.
 *
 * Three sibling layers cover the liveness fix, each load-bearing (issue #167):
 *
 *   - **this hermetic layer** asserts the server's liveness-frame *emission* holds an idle
 *     downstream past the timeout, DETERMINISTICALLY — a worker STAND-IN embodies the
 *     `--sdk-url` reader's timeout contract, the server is booted with a SHORT liveness
 *     interval, and the whole thing runs on loopback with no credentials, so it gates on
 *     every CI run;
 *   - the fenced **live-worker oracle** (`live-worker-oracle.ts`, #133) confirms a REAL
 *     worker holds idle — credentialed, opt-in, skips-never-fakes;
 *   - the **inference-untouched canary** (`traffic-harness.ts`, #134) is the self-guard
 *     posture this layer reuses: a negative-space assertion ("no drop") means something
 *     ONLY if the detector that would catch a drop can be shown to fire.
 *
 * **The stand-in models the worker's contract, not just a frame sink.** A bare "≥1 frame
 * arrived" assertion is vacuous as a liveness regression: it never models the ~45s deadline
 * the frames exist to beat. So the {@link WorkerLivenessStandIn} embodies the worker's
 * downstream-liveness contract — it holds ONE registration and ONE downstream open, and runs
 * a liveness monitor that (like a real SSE reader) resets a deadline on every `client_event`
 * frame it reads and records a **drop** if the gap between counted frames ever exceeds
 * {@link WORKER_LIVENESS_TIMEOUT_MS}. A drop is EXACTLY the event that forces a real worker to
 * tear the stream down and reconnect + re-register — the flap #166 removes — so `drops === 0`
 * IS the receiver-grounded proof of "held idle with no reconnect / re-register"; the stand-in
 * need not perform the reconnect to prove the server prevented its trigger.
 *
 * **Fails on the pre-#166 behavior, and proves it does (self-guard).** The positive drive
 * ({@link assertIdleHeldPastLivenessTimeout}) fails on the pre-fix behavior by construction:
 * pre-#166 the server emits ZERO `client_event` frames on an idle downstream, so the
 * stand-in's deadline fires (`drops > 0`) and no liveness frame lands in the window
 * ({@link classifyIdleHold} → not held). But "no drop" is only meaningful if the monitor CAN
 * fire — the exact circular-fixture trap #131/#134 removed. So the suite pairs the positive
 * drive with a **starved** negative control (a server whose liveness interval is pushed far
 * above the hold window reproduces pre-#166 within it): the SAME stand-in must then record a
 * drop, proving the monitor genuinely catches the pre-fix behavior. Only that pairing makes a
 * green positive run trustworthy.
 *
 * **Scaled time (deterministic, and a strictly stronger regression).** Wall-clock ~45s is
 * unfit for CI, so the contract is exercised at ms scale: the server's emit interval is
 * {@link LIVENESS_FRAME_INTERVAL_MS} (the proven-reliable value the server unit suite uses)
 * and the stand-in's modeled deadline is {@link WORKER_LIVENESS_TIMEOUT_MS}. The production
 * ratio is `DEFAULT_WORKER_LIVENESS_INTERVAL_MS` (20s) below the ~45s timeout (≈2.25×); the
 * scaled ratio is deliberately WIDER (8×), for two compounding reasons: (a) ms-scale
 * scheduling jitter is proportionally larger than at the 20s/45s scale, so a wide margin
 * removes flakiness; and (b) a wider deadline only STRENGTHENS the regression — pre-#166 emits
 * zero frames, so it times out regardless of how generous the deadline is, while a post-#166
 * run has more slack to land its frame. The essential contract (`interval < timeout`, a
 * periodic frame holding the stream across multiple deadline windows) is preserved.
 */

import type { CcctlServer } from "@ccctl/server";
import { connectFakeWorker, type FakeWorker, type ReceivedClientEvent } from "./one-session-harness.js";

// --- scaled-time constants ---

/**
 * The SHORT per-session liveness-frame interval (ms) a hermetic run boots the server with
 * ({@link ServerConfig.workerLivenessIntervalMs}) so the #166 timer fires within a test
 * window. Matches the value the server's own worker-channel unit suite uses — proven
 * reliable in CI. The scaled proxy for the production `DEFAULT_WORKER_LIVENESS_INTERVAL_MS`
 * (20s).
 */
export const LIVENESS_FRAME_INTERVAL_MS = 25;

/**
 * The stand-in worker's modeled **downstream-liveness timeout** (ms) — the scaled proxy for
 * the real `--sdk-url` reader's ~45s deadline. Sits at 8× {@link LIVENESS_FRAME_INTERVAL_MS}:
 * a wide margin that removes ms-scale jitter flakiness AND strictly strengthens the
 * regression (pre-#166 emits no frame, so it times out for any deadline; post-#166 has more
 * slack to land its frame within the window). See the module note on scaled time.
 */
export const WORKER_LIVENESS_TIMEOUT_MS = 200;

/**
 * The default idle-hold duration (ms) — 3× {@link WORKER_LIVENESS_TIMEOUT_MS}, so the drive
 * proves the downstream holds ACROSS several deadline windows (the "idle-hold past the
 * timeout" the golden is blind to), not merely within a single frame interval.
 */
export const IDLE_HOLD_MS = 600;

/** How often the liveness monitor samples the downstream for a new frame / a lapsed deadline. */
const DEFAULT_MONITOR_POLL_MS = 10;

// --- the idle-hold verdict (pure) ---

/**
 * The receiver-grounded observation of one idle-hold drive, fed to {@link classifyIdleHold}.
 * Every field is read from the stand-in's OWN receipt (its buffered downstream frames, its
 * monitor's deadline firings) or the server's OWN state (`hasLiveWorker`), never a self-report.
 */
export interface IdleHoldObservation {
  /**
   * All `client_event` frames the stand-in read off its held-open downstream. EVERY
   * `client_event` (liveness or a real turn) resets the worker's deadline, so this is the
   * count that keeps the stream alive.
   */
  readonly clientEventFrames: number;
  /**
   * The subset of {@link clientEventFrames} that are #166 no-op liveness frames
   * (`payload.type === "ccctl_liveness"`) — the frames the server emits with no other purpose
   * than holding the stream.
   */
  readonly livenessFrames: number;
  /**
   * Elapsed ms from the downstream opening to the FIRST liveness frame the stand-in read, or
   * `null` if none ever arrived. The AC2 "within the timeout window" check compares this to
   * {@link livenessTimeoutMs}.
   */
  readonly firstLivenessElapsedMs: number | null;
  /**
   * How many times the stand-in's liveness deadline fired — the gap between counted frames
   * exceeded {@link livenessTimeoutMs}. Each firing is exactly the `connect → liveness-timeout
   * → reconnect` flap trigger #166 removes, so a non-zero count means a real worker would have
   * dropped the stream and reconnected + re-registered.
   */
  readonly drops: number;
  /** Whether the server still held this session's worker downstream open at the end of the hold (`hasLiveWorker`). */
  readonly streamOpenAtEnd: boolean;
  /** The actual wall-clock duration (ms) the downstream was held — from open to snapshot — exceeds {@link livenessTimeoutMs} on a valid drive. */
  readonly holdDurationMs: number;
  /** The modeled worker deadline (ms) this drive ran against ({@link WORKER_LIVENESS_TIMEOUT_MS}). */
  readonly livenessTimeoutMs: number;
}

/** The classified verdict of one idle-hold drive: whether idle held past the timeout, and — if not — why. */
export interface IdleHoldVerdict {
  /** `true` iff the downstream held idle past the liveness timeout with no drop and ≥1 liveness frame in the window. */
  readonly held: boolean;
  /** The named reasons idle did NOT hold — non-empty ONLY when {@link held} is `false`. */
  readonly violations: readonly string[];
  /** A human-readable explanation of the verdict. */
  readonly reason: string;
}

/**
 * Classify one {@link IdleHoldObservation} into a {@link IdleHoldVerdict} — the pure heart of
 * the regression, unit-testable without a live server. Held requires ALL of the acceptance
 * criteria (#167):
 *
 *   - the hold EXCEEDED the liveness timeout (else the drive never crossed the deadline and a
 *     held/not-held verdict is meaningless — the degenerate-window guard);
 *   - the stand-in's liveness deadline NEVER fired (`drops === 0`) — no stream drop, so no
 *     reconnect / re-register was ever triggered (AC1/AC3);
 *   - the server-side downstream was still held at the end (never reaped mid-hold, AC3); and
 *   - ≥1 `client_event` liveness frame landed WITHIN the timeout window (AC2).
 *
 * Any breach is named; the pre-#166 behavior (no frame → the deadline fires and none lands in
 * the window) surfaces as a not-held verdict, which is exactly how the regression fails closed.
 */
export function classifyIdleHold(observation: IdleHoldObservation): IdleHoldVerdict {
  const violations: string[] = [];

  // Degenerate-window guard: the hold must EXCEED the deadline, else the drive never crossed
  // it and cannot prove hold across the timeout (a hold shorter than one window "passes"
  // vacuously). Cardinality-style guard on the temporal subject being evaluated.
  if (observation.holdDurationMs <= observation.livenessTimeoutMs) {
    violations.push(
      `the idle hold (${observation.holdDurationMs}ms) did not exceed the liveness timeout ` +
        `(${observation.livenessTimeoutMs}ms) — the drive never crossed the deadline, so a held verdict is meaningless`,
    );
  }

  // AC1/AC3 — the worker's downstream-liveness deadline must never fire. A firing is the
  // `connect → liveness-timeout → reconnect` flap (a stream drop + a re-register) #166 removes.
  if (observation.drops > 0) {
    violations.push(
      `the downstream-liveness deadline fired ${observation.drops} time(s) — a real worker would have ` +
        `dropped the stream and reconnected / re-registered`,
    );
  }

  // AC3 — the server-side downstream must still be held at the end (never reaped mid-hold).
  if (!observation.streamOpenAtEnd) {
    violations.push("the server no longer held the worker downstream open at the end of the idle window");
  }

  // AC2 — ≥1 `client_event` liveness frame must land WITHIN the timeout window.
  if (observation.livenessFrames < 1) {
    violations.push("no `client_event` liveness frame was observed on the held-open downstream");
  } else if (
    observation.firstLivenessElapsedMs === null ||
    observation.firstLivenessElapsedMs > observation.livenessTimeoutMs
  ) {
    violations.push(
      `the first liveness frame landed at ${observation.firstLivenessElapsedMs ?? "never"}ms, ` +
        `past the ${observation.livenessTimeoutMs}ms liveness window`,
    );
  }

  const held = violations.length === 0;
  return {
    held,
    violations,
    reason: held
      ? `idle held for ${observation.holdDurationMs}ms (> the ${observation.livenessTimeoutMs}ms timeout) on a single ` +
        `continuous downstream: ${observation.livenessFrames} liveness frame(s), first at ` +
        `${observation.firstLivenessElapsedMs}ms, zero liveness-timeout drops`
      : `idle did NOT hold past the liveness timeout: ${violations.join("; ")}`,
  };
}

/**
 * Thrown by {@link assertIdleHeldPastLivenessTimeout} when the idle-hold drive did NOT hold
 * past the timeout — i.e. the server let the downstream go silent and the stand-in's deadline
 * fired, no liveness frame landed in the window, or the stream was reaped. A typed error (not
 * a bare `Error`), mirroring `InferenceGuaranteeViolation` / `StandInLivenessError`, so a
 * caller can distinguish a genuine idle-hold failure from any other throw; the `message`
 * carries the named {@link IdleHoldVerdict.violations}.
 */
export class IdleHoldViolation extends Error {
  /** The classified verdict whose violations produced this throw. */
  readonly verdict: IdleHoldVerdict;
  /** The observation the verdict was classified from. */
  readonly observation: IdleHoldObservation;

  constructor(verdict: IdleHoldVerdict, observation: IdleHoldObservation) {
    super(`ccctl e2e: ${verdict.reason}`);
    this.name = "IdleHoldViolation";
    this.verdict = verdict;
    this.observation = observation;
  }
}

// --- the worker liveness stand-in (impure) ---

/** Whether a frame is a #166 no-op liveness frame: its demux payload is the inert `{ type: "ccctl_liveness" }`. */
function isLivenessFrame(frame: ReceivedClientEvent): boolean {
  const payload = frame.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  return (payload as { type?: unknown }).type === "ccctl_liveness";
}

/** Inputs to open a worker liveness stand-in. */
export interface WorkerLivenessStandInOptions {
  /** The real local ccctl server whose §4/§5 worker channel the stand-in holds open. */
  readonly server: CcctlServer;
  /** The session id (the channel is rooted under it) — the worker channel needs the session to exist. */
  readonly sessionId: string;
  /**
   * The modeled worker downstream-liveness deadline (ms) — a gap between counted frames longer
   * than this is a drop. Defaults to {@link WORKER_LIVENESS_TIMEOUT_MS}.
   */
  readonly livenessTimeoutMs?: number;
  /** How often (ms) the monitor samples the downstream. Defaults to {@link DEFAULT_MONITOR_POLL_MS}. */
  readonly monitorPollMs?: number;
}

/**
 * A worker stand-in that embodies the `--sdk-url` reader's downstream-liveness contract — the
 * SSE client of the held-open downstream plus a liveness monitor modeling the ~45s deadline.
 * It reads the `client_event` frames the server pushes (so "a frame arrived" is grounded in
 * its own receipt) and records a **drop** whenever the gap between counted frames exceeds the
 * modeled deadline — exactly what a real worker's reader does before it reconnects.
 */
export interface WorkerLivenessStandIn {
  /**
   * Hold the downstream idle for `durationMs` while the liveness monitor runs, then resolve
   * the receiver-grounded {@link IdleHoldObservation} (snapshotted BEFORE any close, so
   * `streamOpenAtEnd` reflects the live hold).
   */
  holdIdle(durationMs: number): Promise<IdleHoldObservation>;
  /** Clear the monitor and close the held-open downstream, releasing the channel. */
  close(): Promise<void>;
}

/**
 * Open a worker liveness stand-in: register once, hold ONE downstream open, drive the session
 * to `idle` (the parked-idle case #166 is about — a session waiting for a later steer), and
 * arm the liveness monitor. Rejects if the server does not derive `idle` from the status gate,
 * so a broken idle drive cannot masquerade as a held stream. No account Bearer rides the
 * channel — the §4/§5 credential boundary (#130).
 */
export async function openWorkerLivenessStandIn(options: WorkerLivenessStandInOptions): Promise<WorkerLivenessStandIn> {
  const { server, sessionId } = options;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? WORKER_LIVENESS_TIMEOUT_MS;
  const monitorPollMs = options.monitorPollMs ?? DEFAULT_MONITOR_POLL_MS;

  // §4/§5 — register + hold the downstream open (the canonical e2e stand-in worker). Captured
  // right after the connect resolves: the deadline starts when the downstream opens.
  const worker: FakeWorker = await connectFakeWorker({ server, sessionId });
  const openedAt = Date.now();

  // Drive to idle and ground it in the server's OWN derived activity — the parked-idle session
  // whose downstream #166 must hold.
  await worker.putStatus("idle");
  if (server.sessions.get(sessionId)?.activity.kind !== "idle") {
    await worker.close();
    throw new Error("ccctl e2e: the server did not derive `idle` activity from the stand-in's worker status");
  }

  // The liveness monitor — a real SSE reader's deadline, modeled: reset on every `client_event`
  // frame read, and record a drop when the gap between counted frames exceeds the deadline. It
  // polls the stand-in's buffered frames (a growth = a new frame = a reset). `.unref()` so it
  // never blocks process exit; cleared on close.
  let lastSeenCount = 0;
  let lastFrameAt = openedAt;
  let drops = 0;
  let firstLivenessElapsedMs: number | null = null;

  const monitor = setInterval(() => {
    const now = Date.now();
    const frames = worker.received();
    if (frames.length > lastSeenCount) {
      lastSeenCount = frames.length;
      lastFrameAt = now;
      if (firstLivenessElapsedMs === null && frames.some(isLivenessFrame)) {
        firstLivenessElapsedMs = now - openedAt;
      }
    } else if (now - lastFrameAt > livenessTimeoutMs) {
      // The deadline lapsed with no counted frame — a real worker drops + reconnects here. Re-arm
      // from `now` so one lapsed window is one drop (one reconnect cycle of the flap), not a
      // per-poll storm.
      drops += 1;
      lastFrameAt = now;
    }
  }, monitorPollMs);
  monitor.unref();

  let monitorCleared = false;
  const clearMonitor = (): void => {
    if (!monitorCleared) {
      clearInterval(monitor);
      monitorCleared = true;
    }
  };

  return {
    holdIdle: async (durationMs: number): Promise<IdleHoldObservation> => {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      const frames = worker.received();
      return {
        clientEventFrames: frames.length,
        livenessFrames: frames.filter(isLivenessFrame).length,
        firstLivenessElapsedMs,
        drops,
        streamOpenAtEnd: server.hasLiveWorker(sessionId),
        holdDurationMs: Date.now() - openedAt,
        livenessTimeoutMs,
      };
    },
    close: async (): Promise<void> => {
      clearMonitor();
      await worker.close();
    },
  };
}

// --- the idle-hold assertion (impure) ---

/** Inputs to drive one idle-hold assertion. */
export interface IdleHoldAssertionOptions extends WorkerLivenessStandInOptions {
  /** How long to hold the downstream idle (ms). Defaults to {@link IDLE_HOLD_MS}. */
  readonly idleHoldMs?: number;
}

/**
 * Drive one idle-hold assertion end-to-end and return its {@link IdleHoldObservation}: open a
 * {@link WorkerLivenessStandIn}, hold idle past the timeout, classify, and THROW an
 * {@link IdleHoldViolation} if idle did NOT hold (the pre-#166 behavior). Mirrors the other
 * `assert*` drivers (`assertServerSpeaksBridgeContract`, `assertInferenceUntouched`): a
 * returning call is a positive verdict, never a vacuous one, and the stand-in is always closed
 * (even on a throw), so a serial e2e run leaks no socket.
 */
export async function assertIdleHeldPastLivenessTimeout(
  options: IdleHoldAssertionOptions,
): Promise<IdleHoldObservation> {
  const idleHoldMs = options.idleHoldMs ?? IDLE_HOLD_MS;
  const standIn = await openWorkerLivenessStandIn(options);
  try {
    const observation = await standIn.holdIdle(idleHoldMs);
    const verdict = classifyIdleHold(observation);
    if (!verdict.held) {
      throw new IdleHoldViolation(verdict, observation);
    }
    return observation;
  } finally {
    await standIn.close();
  }
}
