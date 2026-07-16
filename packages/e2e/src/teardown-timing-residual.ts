// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The TEARDOWN-TIMING RESIDUAL oracle (#70, traces E2E-B-003) — the fenced, self-classifying proof
 * that the daemon's session teardown leaves NO lingering handle when it is driven under TIMING
 * PRESSURE: rapid, back-to-back launch/teardown cycles with no settling anywhere.
 *
 * **The gap this closes, and why its two siblings structurally cannot.** All three of W7's residual
 * specs trace E2E-B-003, and each owns a different question:
 *
 *   - **#68 owns the PER-FD question** (`pty-handle-residual.ts`): one launch, one teardown, the pty
 *     master fd and the child read straight off the kernel. But it asks ONCE, over the WHOLE-DAEMON
 *     shutdown path (`server.close()` → `releaseLaunchedSessions`), and it asks UNPRESSURED — a full
 *     `/api/sessions` list round-trip sits between its launch and its teardown. A teardown that only
 *     misbehaves when it is RACED is green there, every time.
 *   - **#69 owns the REF'D-LIBUV TALLY** (`daemon-soak.ts`): many lifecycles, but deliberately PACED
 *     across a long span, and — its own module doc states this boundary in as many words — what it can
 *     see is bounded by what #63's sampler answers, which counts ref'd libuv resources and *not* bare
 *     file descriptors: "A raw fd leak is invisible HERE, and is exactly what #68's oracle asks the
 *     kernel about directly". A leaked pty master fd is INVISIBLE to it, at any cycle count. (The
 *     package README states the same split as a division of labour — "#68 owns the per-fd question
 *     (`fstat`, per-fd), this owns the ref'd-libuv tally".)
 *
 * So a handle that lingers only when teardown is raced is unasked by #68 (one unpressured pass, a
 * different path) and unseeable by #69 (fd-blind). That intersection — **the per-fd question, asked N
 * times, under pressure** — is this oracle's, and it is the whole of what it claims.
 *
 * **The STOP path is FORCED by AC1, not chosen — and it is the genuinely timing-sensitive one.**
 * "Rapid launch/teardown cycles" requires a teardown that can be driven repeatedly against one live
 * daemon. The server has exactly three, and two are unavailable by construction: shutdown
 * (`releaseLaunchedSessions`) is terminal — it can run once — and the ghost-reaper
 * (`pending-launch.ts` § `evictPendingLaunch`) is a timer, not something a drive may ask for. That
 * leaves the emergency stop (#76, `POST /api/sessions/{id}/stop` → `stopLaunchedSession`), which is
 * the only cycleable teardown — and, by its own documentation, the one where timing is load-bearing
 * rather than incidental:
 *
 *   - it is "the first `close()` caller with anyone waiting on it", so it alone carries a DEADLINE
 *     (`session-release.ts` § `STOP_TEARDOWN_TIMEOUT_MS`), where shutdown and the reaper have none; and
 *   - the owned pty "latches `closed` before it awaits the reaping, so once a close has been ABANDONED
 *     by `closeWithinTimeout`, every later `close()` on that handle returns instantly — cheerfully, and
 *     to a still-running child" (`session-release.ts` § `stopLaunchedSession`).
 *
 * That last sentence is a handle/teardown-timing hazard the server names in its own words, and this
 * oracle is the runtime check that the class stays closed.
 *
 * **The stop path buys a STRONGER claim than #68's, and the drive is built on it.** #68 must POLL for
 * convergence because shutdown's release is deliberately fire-and-forget (`void
 * releaseLaunchedSession(launched)`; `close()` never awaits it), so the reaping is genuinely in flight
 * when `close()` resolves. A stop is AWAITED end to end: `stopSession` → `await stopLaunchedSession` →
 * `closeWithinTimeout` → the pty backend's `close()` → `await reaped`, which resolves only once the
 * child has actually exited ("teardown is not 'done' until it has exited",
 * `session-launcher-pty.ts`). So when the stop's `200` lands, the reaping has ALREADY happened, and a
 * residual read a moment later is a real residual rather than a race. The settle window
 * ({@link RESIDUAL_SETTLE_TIMEOUT_MS}) is correspondingly SHORT, and its doc carries the one thing it
 * is still there for.
 *
 * **The stop's own outcome reports the confound #68 had to engineer around.** #68's `WORKER_ARGS`
 * spends a long doc COMPUTING its stand-in's sleep from the drive's own tail, because a child that
 * expired before the after-teardown reading would be reaped by node-pty on its OWN exit and let a
 * LEAKING daemon read clean — a green for a teardown that never ran. This oracle does not need to
 * re-derive that floor, and the reason is not that it got lucky: the stop path REPORTS the confound.
 * A child that died by any other hand makes the daemon's liveness probe read `exited`, which
 * `decideStop` maps to `no-op` and the wire reports as `already-exited` — never `stopped`. So the
 * confound arrives as an OBSERVATION this oracle files as an inconclusive gap
 * ({@link TIMING_RESIDUAL_CHECK.stopTore}), rather than as a silent green. It reuses #68's stand-in
 * (via `createObservedPtyLauncher`) unchanged; the per-cycle child need only outlive its OWN
 * cycle, which is milliseconds.
 *
 * **Where that argument stops, stated rather than glossed.** It closes the confound for a child that
 * dies before the stop's liveness probe. It does NOT close a child that dies in the window BETWEEN that
 * probe (`session-release.ts` § `readLiveness`) and the pty's own `if (exited) return` a moment later
 * (`session-launcher-pty.ts`): there the stop reports `stopped` having signalled nothing, and this
 * oracle would read a green for a teardown that did not run. The window is ~two function calls wide and
 * the stand-in is #68's derived `WORKER_SLEEP_SECONDS` sleep (30s today) against ~200ms cycles, so
 * nothing can reach it here — and it is
 * PRE-EXISTING server behavior rather than something this oracle introduces. It is written down because
 * an oracle that argued its confound away should say exactly how far the argument reaches; closing it
 * would need the stop to report whether it actually signalled, which is #76's contract to change, not
 * this spec's to route around.
 *
 * **Two self-guards, because this oracle asserts two absences, not one.**
 *
 *   1. **"The handle is gone"** — the {@link readHandleState} pair must DISAGREE, per cycle: PRESENT at
 *      launch, GONE after the stop. This is #68's guard, and the reason is its reason — a residual check
 *      answers "is it gone?", and the failure mode of every such check is a probe that says "gone"
 *      because it never looked. A probe stuck on "gone" fails the at-launch reading; one stuck on
 *      "present" fails the after-stop reading. Neither can reach `verified`.
 *   2. **"...under timing pressure"** — the pressure itself is a CLAIM under test, and this is the guard
 *      #68 had no need of. An oracle that drove its cycles slowly, or drove fewer than it planned, or
 *      drove NONE at all, would verify a claim it never bought. So the plan is declared
 *      ({@link TeardownTimingPlan}), the drive MEASURES the launch→stop gap it actually achieved, and
 *      {@link classifyTeardownTimingResidual} refuses to verify a run that fell short of either axis —
 *      the same discipline `classifyDaemonSoak` applies to #69's span, where it "refuses to `verified` a
 *      soak that fell short of the plan it was handed". A zero-cycle run is `inconclusive`, never
 *      `verified`.
 *
 * **Why the gap ceiling is worth its own axis, when the drive dispatches the stop on the very next
 * statement.** Today the gap is microseconds and the ceiling cannot fire; the ceiling is not there to
 * measure the daemon, it is there to keep THIS FILE honest. The moment someone "fixes a flake" by
 * sleeping between the launch and the stop, the pressure this oracle is named for is gone — and it
 * would go silently, because the run stays GREEN while no longer testing anything #68 does not already
 * cover. That is the same hole #68's `WORKER_ARGS` doc refuses to leave open ("the reopened hole is
 * invisible, because it fails as a GREEN"). Measured and gated, it fails as an `inconclusive` that
 * names the axis instead.
 *
 * **What is REAL here**: the `node-pty` native binding, every pty and child it spawns, every master fd,
 * the daemon's launch ingress (`POST /api/sessions`) and stop ingress (`POST /api/sessions/{id}/stop`)
 * — both carrying the phone's OWN bodies, built by the REAL `@ccctl/web-ui` modules — the registry, the
 * pending-launch bookkeeping, the #35/#76 safe-teardown rule, and the launcher's whole
 * probe/close/escalate/reap orchestration. What is a STAND-IN: only the worker the pty runs, for the
 * reason #68's module doc gives at length (the repo ships no packaged patched worker, and neither
 * oracle's ACs are about registration).
 *
 * **Fenced / opt-in on #68's arm — deliberately SHARED rather than its own.** Every other fenced oracle
 * here carries its own arm because its prerequisite is its own piece of infrastructure. This one's
 * prerequisite is not merely similar to #68's, it is IDENTICAL: a real, spawn-capable `node-pty` on
 * this box, which a default checkout has on neither platform (#68's module doc is the one canonical
 * account of why, per-platform, and is deliberately not restated here — a restated copy is what
 * drifts). So it reuses {@link resolvePtyE2EEnv} rather than inventing `CCCTL_E2E_PTY_TIMING`. A third
 * variable would not gate anything the second does not already gate, and would make an operator who
 * armed the pty oracle silently skip this one for no infrastructural reason — an arm should name a
 * prerequisite, not a spec.
 *
 * The fence + the classifier (the Tier-A encoding of #70's two ACs) + the drive's own mechanics are
 * proven credential-free in `teardown-timing-residual.test.ts`, so what is fenced is the BINDING, not
 * the judgment.
 */

import {
  readHandleState,
  waitForResidualToSettle,
  type HandleReading,
  type ObservedSpawn,
  type PtyFence,
} from "./pty-handle-residual.js";
import type { HostEndpoint } from "@ccctl/core";

// --- the fence ---

/**
 * A one-line, human-readable rendering of this oracle's fence — the suite title's suffix.
 *
 * The fence itself is #68's ({@link resolvePtyE2EEnv}); only the WORDING is this oracle's, so an
 * operator reading a skip learns which spec skipped rather than which module's helper rendered it.
 * There is no second fence to drift.
 */
export function describeTeardownTimingFence(fence: PtyFence): string {
  return fence.ready
    ? "teardown-timing oracle armed (CCCTL_E2E + CCCTL_E2E_PTY present)"
    : `teardown-timing oracle fenced off — missing ${fence.missing.join(", ")}`;
}

// --- the plan (AC1's axes) ---

/** What a timing run is asked to achieve — the pressure it must BUY before it may claim it. */
export interface TeardownTimingPlan {
  /**
   * How many rapid launch/teardown cycles to drive. The classifier refuses to verify a run that drove
   * fewer, so the number is a commitment rather than a hint.
   */
  readonly cycles: number;
  /**
   * The ceiling, in milliseconds, on the launch→stop dispatch gap that still counts as "rapid" — the
   * teeth behind AC1's "under timing pressure". See the module doc for why this axis exists at all when
   * the drive already dispatches the stop on the next statement.
   */
  readonly maxLaunchToStopGapMs: number;
}

/**
 * The default plan. Twelve cycles rather than one is what makes this a TIMING claim: a teardown whose
 * defect depends on an interleaving does not have to reproduce on the first attempt, and #68 already
 * covers the single unpressured pass exhaustively — a one-cycle run here would add nothing it does not
 * already own. Twelve is also cheap enough to gate on every armed box rather than be something an
 * operator schedules: MEASURED at ~2.4s for the whole run (~196ms/cycle) on a 2026 darwin-arm64 laptop.
 * Note what that cost is and is not — it is the LAUNCH (a real `node-pty` spawn through the daemon's
 * ingress), not the teardown: the settle loop measured 0 polls on every cycle, because the stop is
 * awaited and the residual is already gone when its `200` lands.
 *
 * The gap ceiling is deliberately GENEROUS — three orders of magnitude above the microseconds the drive
 * actually spends between the launch and the stop. It is not a measurement of the daemon and must never
 * fire on a merely loaded box (a GC pause between the two statements is not a lost claim); it is a
 * tripwire on the ONE regression that would silently void this oracle — a settling sleep introduced
 * between the two legs. See the module doc.
 */
export const DEFAULT_TEARDOWN_TIMING_PLAN: TeardownTimingPlan = {
  cycles: 12,
  maxLaunchToStopGapMs: 250,
};

/**
 * Resolve the plan from an environment — `CCCTL_E2E_TIMING_CYCLES` raises the cycle count for an
 * operator who wants to lean on the teardown harder than the default does.
 *
 * Only the cycle count is an operator lever, and the asymmetry is deliberate. Cycles are what AC1 asks
 * for MORE of, and more is always a stronger claim. The gap ceiling is not in the same category: it is
 * this oracle's own honesty tripwire (module doc), so an env var that RAISED it would be a knob whose
 * only use is to switch the guard off — the one thing it exists to prevent. It stays a constant.
 *
 * Pure over the injected `env` (defaults to `process.env`), so the plan is unit-testable without
 * mutating the process environment. A value that is absent, unparseable or non-positive falls back to
 * the default rather than failing the run: a typo in an operator's shell must not read as a defect in
 * the daemon.
 *
 * The parse is STRICT — whole digits only — rather than `parseInt`, which is lenient in exactly the
 * direction that hurts here: it reads a prefix and discards the rest, so `1.5e3z` becomes `1` and
 * `12abc` becomes `12`. An operator who fat-fingered their cycle count would then get a run that looks
 * armed, reports a plausible number, and quietly drove a pressure nobody chose — the same class of
 * silent-wrong-value this oracle's own gap ceiling exists to prevent. Falling back to the default is
 * the honest read of a value this cannot understand.
 */
export function resolveTeardownTimingPlan(env: NodeJS.ProcessEnv = process.env): TeardownTimingPlan {
  const raw = env.CCCTL_E2E_TIMING_CYCLES?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return DEFAULT_TEARDOWN_TIMING_PLAN;
  }
  const cycles = Number(raw);
  return cycles > 0 ? { ...DEFAULT_TEARDOWN_TIMING_PLAN, cycles } : DEFAULT_TEARDOWN_TIMING_PLAN;
}

// --- the drive's timings ---

/**
 * How long the drive waits for a stopped session's handle to settle.
 *
 * SHORT on purpose, and the brevity is EARNED rather than a shortcut — it is the direct consequence of
 * the stop path being awaited (module doc). #68's window is 10s because it reads after a
 * fire-and-forget release that is genuinely still in flight; here the stop's `200` already means the
 * child has been reaped, so there is no in-flight teardown to converge to and nothing this window is
 * waiting ON.
 *
 * It is not zero only because the fd's release is node-pty's own business rather than the daemon's: the
 * child's exit is what closes the master descriptor, and asserting the two land in the same event-loop
 * tick would be a claim about the BINDING's internals that this oracle has no business making — and
 * would buy a flake for it. Polling to a short deadline costs nothing on a healthy run (the loop exits
 * the instant the residual is gone) and costs this much only on a run that is already failing, because
 * a genuine residual never settles: the deadline passes, the last reading still shows it, and the
 * classifier reads that as `drift`.
 */
export const RESIDUAL_SETTLE_TIMEOUT_MS = 2_000;

// --- the verdict (pure) ---

/** The oracle's tri-state verdict — the same vocabulary every fenced oracle in this package speaks. */
export type TeardownTimingVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const TIMING_RESIDUAL_CHECK = {
  backend: "real-pty-spawn (AC1)",
  launch: "daemon-launch-ingress (AC1)",
  masterFd: "pty-master-fd (AC1)",
  cyclesDriven: "planned-cycles-driven (AC1)",
  pressure: "launch-to-stop-gap (AC1)",
  childLive: "child-live-on-launch (AC2)",
  fdOpened: "fd-open-on-launch (AC2)",
  stopAnswered: "stop-answered (AC2)",
  stopTore: "stop-tore-down (AC2)",
  childReaped: "child-reaped-on-stop (AC2)",
  fdReleased: "fd-released-on-stop (AC2)",
} as const;

/** Everything ONE rapid cycle observed. */
export interface TimingCycleCapture {
  /** Which cycle this was, zero-based — so a violation names WHICH one drifted. */
  readonly index: number;
  /** What the REAL spawn produced on THIS cycle. Absent → this launch brought no pty up. */
  readonly spawned?: ObservedSpawn | undefined;
  /** The daemon's own answer to the phone's launch. */
  readonly launchStatus?: number | undefined;
  /** The typed `code` the daemon reported when the launch failed — why the real backend could not spawn. */
  readonly launchFailure?: string | undefined;
  /** The session id the daemon minted, read from its OWN 201 body. */
  readonly sessionId?: string | undefined;
  /** The OS's reading while the session is UP — the residual self-guard's live half. */
  readonly atLaunch?: HandleReading | undefined;
  /**
   * How long the drive itself spent between the launch's answer and the stop's dispatch — AC1's
   * "timing pressure", MEASURED. See {@link TeardownTimingPlan.maxLaunchToStopGapMs}.
   */
  readonly launchToStopGapMs?: number | undefined;
  /** The daemon's own answer to the phone's stop. */
  readonly stopStatus?: number | undefined;
  /** What the stop reported it DID (`stopped` / `already-exited`) — read from its own 200 body. */
  readonly stopOutcome?: string | undefined;
  /** The typed `code` the daemon reported when the stop failed. */
  readonly stopFailure?: string | undefined;
  /** The OS's reading after the daemon's stop returned. */
  readonly afterStop?: HandleReading | undefined;
}

/** Everything one drive observed — the input to the pure {@link classifyTeardownTimingResidual}. */
export interface TeardownTimingCapture {
  /** What the run was ASKED to achieve — the claim its verdict is measured against. */
  readonly plan: TeardownTimingPlan;
  /** What each cycle observed, in order. */
  readonly cycles: readonly TimingCycleCapture[];
}

/** What a run actually ACHIEVED — carried on every report, so a verdict can never overstate it. */
export interface ObservedPressure {
  /** How many cycles were actually driven. */
  readonly cycles: number;
  /** The worst launch→stop gap any cycle spent, or `undefined` when no cycle measured one. */
  readonly maxLaunchToStopGapMs?: number | undefined;
}

/** One drive's verdict, the checks it violated, and the pressure it actually achieved. */
export interface TeardownTimingReport {
  readonly verdict: TeardownTimingVerdict;
  /** The checks whose OBSERVED behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation: what verified, what drifted, or what was never captured. */
  readonly reason: string;
  /**
   * The pressure this run BOUGHT — always populated, on every verdict. The verdict never lies about
   * AC1: a report that verified 3 cycles says 3, so a reader can never mistake it for the 12 the plan
   * asked for (#69's `spannedMultiDay` posture, applied to this oracle's axes).
   */
  readonly observed: ObservedPressure;
}

/**
 * The PURE decision — #70's two ACs, encoded (Tier A) and unit-tested credential-free.
 *
 * Ordering is load-bearing and matches this package's other classifiers: DRIFT is checked FIRST, so a
 * present-but-wrong observation is never masked by a downstream gap. A leaked fd is a leak whether or
 * not the run also fell short of its plan — indeed a run that drifted on cycle 3 of 12 and stopped
 * there has BOTH, and the leak is the news.
 */
export function classifyTeardownTimingResidual(capture: TeardownTimingCapture): TeardownTimingReport {
  const observed = observePressure(capture.cycles);
  const violations: string[] = [];

  // 1. DRIFT — contract violations actually OBSERVED, per cycle.
  for (const cycle of capture.cycles) {
    violations.push(...cycleViolations(cycle));
  }
  if (violations.length > 0) {
    return {
      verdict: "drift",
      violations,
      reason:
        `the real pty ran under timing pressure but violated ${violations.length} check(s) across ` +
        `${observed.cycles} cycle(s): ${violations.join("; ")}`,
      observed,
    };
  }

  // 2. INCONCLUSIVE — nothing drifted, but a required observation is missing, or the run did not buy
  //    the pressure it would be claiming. Each gap is a question this run could not ask; answering it
  //    anyway would be the fabricated green the package forbids.
  const gaps = captureGaps(capture);
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not measure the teardown's handle residual under timing pressure: ${gaps.join("; ")}`,
      observed,
    };
  }

  return {
    verdict: "verified",
    violations: [],
    reason:
      `${observed.cycles} rapid launch/stop cycles against the REAL node-pty backend each opened a live ` +
      `pty master fd and a live child, and the daemon's own stop tore each one down with NO residual — ` +
      `every child reaped, every descriptor released, worst launch→stop gap ` +
      `${observed.maxLaunchToStopGapMs ?? "?"}ms (ceiling ${capture.plan.maxLaunchToStopGapMs}ms)`,
    observed,
  };
}

/**
 * What one cycle OBSERVED that violates the contract — the drift half of the classifier.
 *
 * Most of these checks RE-STATE #68's (`classifyPtyHandleResidual`) rather than share them, and
 * the asymmetry with `waitForResidualToSettle` — which #68's doc insists must exist exactly once — is
 * deliberate. A classifier is the Tier-A encoding of ONE issue's ACs; a shared one would let an AC
 * change here silently re-word or re-scope #68's release-gating verdict. The standing obligation the
 * fork buys is that the fd/child predicate here must stay in agreement with #68's `hasSettled`, which
 * is what decides when this oracle stops polling — change one, re-read the other.
 */
function cycleViolations(cycle: TimingCycleCapture): string[] {
  const violations: string[] = [];
  const at = `cycle ${cycle.index}`;

  // AC1: a real pty came up, but the daemon's own ingress disagreed. A spawn WITH a non-201 is a
  // genuine contradiction (a surface exists that the daemon says it never launched); a non-201 with NO
  // spawn is just the backend being unavailable — an inconclusive gap below, not a drift. (#68's rule,
  // re-stated here rather than shared — see this function's doc; only the PROBE is genuinely shared.)
  if (cycle.spawned !== undefined && cycle.launchStatus !== undefined && cycle.launchStatus !== 201) {
    violations.push(
      `${TIMING_RESIDUAL_CHECK.launch}: ${at} spawned a real pty but the daemon answered ` +
        `${cycle.launchStatus}${cycle.launchFailure !== undefined ? ` (${cycle.launchFailure})` : ""} — ` +
        `a surface exists that the launch denies`,
    );
  }

  // AC2, "opened on launch" — a claim under test, not a precondition, and the residual self-guard's
  // live half. Without it a probe stuck on "gone" would verify every cycle vacuously.
  if (cycle.atLaunch !== undefined) {
    if (!cycle.atLaunch.childPresent) {
      violations.push(
        `${TIMING_RESIDUAL_CHECK.childLive}: ${at}'s child was already gone at launch ` +
          `(${cycle.atLaunch.childErrno ?? "?"}) — nothing was ever opened to reap`,
      );
    }
    if (!cycle.atLaunch.fdOpen) {
      violations.push(
        `${TIMING_RESIDUAL_CHECK.fdOpened}: ${at}'s pty master fd was not open at launch ` +
          `(${cycle.atLaunch.fdErrno ?? "?"})`,
      );
    } else if (cycle.atLaunch.fdCharacterDevice === false) {
      violations.push(`${TIMING_RESIDUAL_CHECK.fdOpened}: ${at}'s launched fd is open but is NOT a character device`);
    }
  }

  // AC2, "the timing-sensitive teardown behaves correctly" — the stop must ANSWER. A stop that failed
  // under pressure is precisely the defect class this oracle exists for: `stop-failed` (502) is what the
  // server raises when a close rejected or when its own post-close re-read caught a surface that
  // "reported a successful close but is still running".
  if (cycle.stopStatus !== undefined && cycle.stopStatus !== 200) {
    violations.push(
      `${TIMING_RESIDUAL_CHECK.stopAnswered}: ${at}'s stop answered ${cycle.stopStatus}` +
        `${cycle.stopFailure !== undefined ? ` (${cycle.stopFailure})` : ""} — the teardown under timing ` +
        `pressure did not succeed`,
    );
  } else if (cycle.stopStatus === undefined && cycle.stopFailure !== undefined) {
    // The stop request never completed — the `fetch` itself threw, so the daemon was never asked.
    //
    // This MUST be named here, in the drift half, even though "the drive could not ask" reads like an
    // inconclusive gap. The reason is the ordering: the after-reading still happens (a stop that failed
    // is exactly when a residual is there to see), so `childReaped` / `fdReleased` fire, and DRIFT
    // outranks gaps — `captureGaps` never runs, taking this cycle's gap report with it. Named only
    // there, the verdict would read "the child survived the daemon's stop" with no hint that the stop
    // never reached the daemon: the reader would hunt a handle leak that is really a broken drive. That
    // is the same "a second, unrelated finding wearing this oracle's red" hazard `freshCwd` guards
    // against, arriving from the transport side.
    violations.push(
      `${TIMING_RESIDUAL_CHECK.stopAnswered}: ${at}'s stop never reached the daemon (${cycle.stopFailure}) — ` +
        `any residual named below is UNATTRIBUTED: the teardown was never asked for, so this is a broken ` +
        `drive rather than a daemon that leaked`,
    );
  }

  // AC2, "no handle is left lingering" — THE RESIDUAL.
  if (cycle.afterStop !== undefined) {
    if (cycle.afterStop.childPresent) {
      violations.push(
        `${TIMING_RESIDUAL_CHECK.childReaped}: ${at}'s child survived the daemon's stop — it is still in ` +
          `the process table${cycle.afterStop.childErrno === "EPERM" ? " (EPERM: alive, no longer ours)" : ""}`,
      );
    }
    // A leak ONLY when the descriptor is still open AND still points at the SAME object. A different
    // identity means the original WAS released and its number recycled — a pass. POSIX hands out the
    // lowest free descriptor, so under RAPID cycles this is not a theoretical nicety: the very next
    // cycle's pty master is a prime candidate for the number this one just freed, and a bare "is fd 12
    // open?" would fail a faithful daemon on cycle 2. (#68's rule; the pressure is what makes it bite.)
    if (
      cycle.afterStop.fdOpen &&
      cycle.atLaunch?.fdIdentity !== undefined &&
      cycle.afterStop.fdIdentity === cycle.atLaunch.fdIdentity
    ) {
      violations.push(
        `${TIMING_RESIDUAL_CHECK.fdReleased}: ${at}'s pty master fd is still open on the SAME object ` +
          `(${cycle.afterStop.fdIdentity}) after the stop — the descriptor leaked`,
      );
    }
  }

  return violations;
}

/** What this run could not ASK — the inconclusive half of the classifier. */
function captureGaps(capture: TeardownTimingCapture): string[] {
  const gaps: string[] = [];

  // AC1, the cardinality floor. A zero-cycle run has violated nothing and proven nothing; verifying it
  // would be this package's worst failure mode — a green from a probe that never ran at all.
  if (capture.cycles.length === 0) {
    gaps.push(`${TIMING_RESIDUAL_CHECK.cyclesDriven}: no cycle was driven at all — nothing was measured`);
    return gaps;
  }
  if (capture.cycles.length < capture.plan.cycles) {
    gaps.push(
      `${TIMING_RESIDUAL_CHECK.cyclesDriven}: only ${capture.cycles.length} of the planned ` +
        `${capture.plan.cycles} cycles were driven — the run fell short of the pressure it would be claiming`,
    );
  }

  for (const cycle of capture.cycles) {
    const at = `cycle ${cycle.index}`;
    if (cycle.spawned === undefined) {
      gaps.push(
        `${TIMING_RESIDUAL_CHECK.backend}: ${at}'s launch brought no pty up` +
          (cycle.launchFailure !== undefined ? ` (the daemon reported \`${cycle.launchFailure}\`)` : ""),
      );
      // Every later gap for this cycle follows from the absent spawn; naming them all would bury the
      // one fact that explains them.
      continue;
    }
    if (cycle.spawned.fd === undefined) {
      gaps.push(
        `${TIMING_RESIDUAL_CHECK.masterFd}: ${at}'s handle exposes no master fd — this is not a POSIX pty ` +
          `(a Windows ConPTY handle has none), so the FD residual cannot be asked here`,
      );
      continue;
    }
    if (cycle.atLaunch === undefined) {
      gaps.push(`${TIMING_RESIDUAL_CHECK.fdOpened}: ${at}'s handle was never read while the session was up`);
    }
    if (cycle.stopStatus === undefined) {
      // No `stopFailure` to render here: a stop that FAILED to reach the daemon is a violation
      // (`cycleViolations`), so it never reaches this function — an unanswered stop at this point is
      // one the drive never got to ask.
      gaps.push(`${TIMING_RESIDUAL_CHECK.stopAnswered}: ${at}'s stop ingress never answered`);
    } else if (cycle.stopStatus === 200 && cycle.stopOutcome !== "stopped") {
      // The stop succeeded but reports it tore NOTHING down — `already-exited`, i.e. the daemon's
      // liveness probe found the surface gone before it acted. The child died by some other hand, so
      // the teardown under test never ran and this cycle's clean after-reading is worthless. This is
      // the confound #68 had to engineer its stand-in's sleep floor around; the stop path REPORTS it,
      // so it lands here as a gap rather than passing as a green (see the module doc).
      gaps.push(
        `${TIMING_RESIDUAL_CHECK.stopTore}: ${at}'s stop reported \`${cycle.stopOutcome ?? "?"}\` rather than ` +
          `\`stopped\` — the surface was already gone, so the teardown under test never ran`,
      );
    }
    if (cycle.afterStop === undefined) {
      gaps.push(`${TIMING_RESIDUAL_CHECK.fdReleased}: ${at}'s handle was never read after the stop`);
    }
    // AC1's teeth. A cycle that settled before stopping did not test a RACED teardown, whatever else it
    // proved — so the run cannot claim the pressure, and says so rather than quietly meaning less.
    if (cycle.launchToStopGapMs === undefined) {
      gaps.push(`${TIMING_RESIDUAL_CHECK.pressure}: ${at}'s launch→stop gap was never measured`);
    } else if (cycle.launchToStopGapMs > capture.plan.maxLaunchToStopGapMs) {
      gaps.push(
        `${TIMING_RESIDUAL_CHECK.pressure}: ${at} let ${cycle.launchToStopGapMs}ms pass between the launch ` +
          `and the stop, over the ${capture.plan.maxLaunchToStopGapMs}ms ceiling — this teardown was not raced`,
      );
    }
  }
  return gaps;
}

/** Read back the pressure a set of cycles actually achieved. */
function observePressure(cycles: readonly TimingCycleCapture[]): ObservedPressure {
  const gaps = cycles.map((cycle) => cycle.launchToStopGapMs).filter((gap): gap is number => gap !== undefined);
  return {
    cycles: cycles.length,
    maxLaunchToStopGapMs: gaps.length > 0 ? Math.max(...gaps) : undefined,
  };
}

// --- the drive (impure) ---

/** What {@link driveTeardownTimingResidual} needs: a real daemon on the real backend, and its ingresses. */
export interface TeardownTimingDriveConfig {
  /**
   * The REAL local server, wired with the REAL owned-pty launcher (`createObservedPtyLauncher`, #68).
   *
   * Typed to the ONE thing the drive reads off it — the address it bound — rather than the whole
   * `CcctlServer`. That is #68's own `readMasterFd` principle ("the port stays honest about what
   * it needs") applied to this seam: a real server satisfies it structurally, so the fenced spec passes
   * its `CcctlServer` unchanged, while the credential-free suite's stand-in daemon can satisfy it too
   * WITHOUT the whole config being cast past the typechecker. #68 declares the wide type and never
   * feels it because it does not unit-test its drive; this oracle does, which is what makes the
   * difference bite.
   */
  readonly server: { readonly address: HostEndpoint };
  /**
   * EVERY spawn the observed launcher has produced, oldest first. The LIST rather than #68's
   * single-slot `observed()`, because that slot is overwritten per spawn: a cycle whose launch spawned
   * nothing would read the PREVIOUS cycle's pid + fd and probe a handle that is already gone —
   * fabricating a verdict in either direction. Each cycle takes only a spawn it newly produced.
   */
  readonly spawns: () => readonly ObservedSpawn[];
  /**
   * A FRESH canonical directory per cycle. Fresh rather than one reused across the run so that each
   * cycle's verdict is about the TEARDOWN and nothing else: a stop that failed leaves its pending-launch
   * record behind, and #33 keys launch correlation on `(cwd, mode)`, so a reused directory would let one
   * cycle's failure surface as the NEXT cycle's `ambiguous-surface` refusal — a second, unrelated
   * finding wearing this oracle's red. Rapid relaunch into the same directory is #33's own claim, with
   * its own specs; it is not this one's.
   */
  readonly freshCwd: () => Promise<string>;
  /**
   * Build the phone's own launch body. INJECTED because `@ccctl/web-ui` is dependency-free plain JS with
   * no type declarations, so its import lives in the (untypechecked) test file rather than in this
   * typechecked source — the placement every web-ui call site in this package uses.
   */
  readonly buildLaunchRequest: (cwd: string) => unknown;
  /** The phone's own stop path (`@ccctl/web-ui` § `sessionStopPath`). INJECTED, same reason. */
  readonly stopPath: (sessionId: string) => string;
  /** Build the phone's own stop body (`@ccctl/web-ui` § `stopRequest`). INJECTED, same reason. */
  readonly buildStopRequest: () => unknown;
  /** What to achieve; defaults to {@link DEFAULT_TEARDOWN_TIMING_PLAN}. */
  readonly plan?: TeardownTimingPlan;
  /** How long to let a stopped handle settle; defaults to {@link RESIDUAL_SETTLE_TIMEOUT_MS}. */
  readonly settleTimeoutMs?: number;
  /**
   * The clock the launch→stop gap is measured on. Injected so the drive's OWN pressure mechanics are
   * unit-testable without a real pty — the same posture #69's soak takes with its clock and sampler.
   */
  readonly now?: () => number;
}

/**
 * Drive N rapid launch/stop cycles end-to-end and self-classify the teardown's handle residual.
 *
 * NEVER throws on a divergence or a missing leg — it returns a {@link TeardownTimingReport}, so the
 * caller's `switch` is the ONLY place a verdict becomes a pass / fail / skip. That is the package's
 * skips-never-fakes posture: an absent binding is `inconclusive`, a lingering handle is `drift`, and
 * only a full set of complete, disagreeing readings taken under the planned pressure is `verified`.
 */
export async function driveTeardownTimingResidual(config: TeardownTimingDriveConfig): Promise<TeardownTimingReport> {
  const plan = config.plan ?? DEFAULT_TEARDOWN_TIMING_PLAN;
  const cycles: TimingCycleCapture[] = [];

  for (let index = 0; index < plan.cycles; index += 1) {
    const cycle = await driveOneCycle(config, index);
    cycles.push(cycle);
    if (cycle.spawned === undefined) {
      // The backend brought no pty up. On a box without a spawn-capable binding EVERY remaining cycle
      // would fail identically, so driving them would buy nothing but N copies of one gap — the verdict
      // is already settled (`inconclusive`, naming the daemon's own typed reason). Stopping here is
      // also what keeps that verdict HONEST rather than merely faster: `observed.cycles` then reports
      // the 1 cycle actually driven, and the plan-shortfall gap says so in as many words.
      break;
    }
  }

  return classifyTeardownTimingResidual({ plan, cycles });
}

/** Drive ONE rapid cycle: launch → read the OS → stop with NO settling → read the OS again. */
async function driveOneCycle(config: TeardownTimingDriveConfig, index: number): Promise<TimingCycleCapture> {
  const origin = `http://${config.server.address.host}:${config.server.address.port}`;
  const now = config.now ?? Date.now;
  const cwd = await config.freshCwd();
  const spawnsBefore = config.spawns().length;

  // 1. The phone launches — its OWN body, onto the REAL pty backend.
  let launchStatus: number | undefined;
  let launchFailure: string | undefined;
  let sessionId: string | undefined;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config.buildLaunchRequest(cwd)),
    });
    launchStatus = res.status;
    const body = (await res.json()) as { sessionId?: string; code?: string; error?: string };
    sessionId = body.sessionId;
    if (res.status !== 201) {
      // The daemon's OWN typed reason (#33) — `backend-unavailable` when node-pty could not load,
      // `spawn-failed` when it loaded but could not spawn. Both are the default-checkout outcome, for
      // the two per-platform reasons #68's module doc is the ONE canonical account of. Carried into the
      // verdict so an `inconclusive` says WHY rather than merely that it could not run.
      launchFailure = body.code ?? body.error;
    }
  } catch (error) {
    launchFailure = `the launch request itself failed: ${(error as Error).message}`;
  }
  const launchAnsweredAt = now();

  // Only a spawn THIS launch produced — never the slot's previous occupant (see `spawns` on the config).
  const spawnsAfter = config.spawns();
  const spawned = spawnsAfter.length > spawnsBefore ? spawnsAfter.at(-1) : undefined;
  const fd = spawned?.fd;

  // 2. Read the OS while the session is UP — the residual self-guard's live half.
  const atLaunch = spawned !== undefined && fd !== undefined ? readHandleState(spawned.pid, fd) : undefined;

  // 3. THE PRESSURE: stop IMMEDIATELY. No settling, no list round-trip, no sleep — the teardown is
  //    dispatched into a session whose launch has only just answered, which is the whole of AC1. The gap
  //    is measured rather than asserted, so a future edit that reintroduces settling cannot pass as a
  //    green (module doc).
  let launchToStopGapMs: number | undefined;
  let stopStatus: number | undefined;
  let stopOutcome: string | undefined;
  let stopFailure: string | undefined;
  if (sessionId !== undefined) {
    launchToStopGapMs = now() - launchAnsweredAt;
    try {
      const res = await fetch(`${origin}${config.stopPath(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config.buildStopRequest()),
      });
      stopStatus = res.status;
      const body = (await res.json()) as { outcome?: string; code?: string; error?: string };
      stopOutcome = body.outcome;
      if (res.status !== 200) {
        stopFailure = body.code ?? body.error;
      }
    } catch (error) {
      stopFailure = `the stop request itself failed: ${(error as Error).message}`;
    }
  }

  // 4. Read the OS after the stop. Attempted whenever a stop was — INCLUDING one that failed, because a
  //    stop that could not tear the surface down is exactly when the residual is there to be seen, and
  //    naming both the failed stop and the handle it stranded is the whole report.
  const afterStop =
    stopStatus !== undefined || stopFailure !== undefined
      ? spawned !== undefined && fd !== undefined
        ? await waitForResidualToSettle(spawned.pid, fd, atLaunch, config.settleTimeoutMs ?? RESIDUAL_SETTLE_TIMEOUT_MS)
        : undefined
      : undefined;

  return {
    index,
    spawned,
    launchStatus,
    launchFailure,
    sessionId,
    atLaunch,
    launchToStopGapMs,
    stopStatus,
    stopOutcome,
    stopFailure,
    afterStop,
  };
}
