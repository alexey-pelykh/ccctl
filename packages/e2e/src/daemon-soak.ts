// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The LONG-RUN DAEMON SOAK oracle (#69, traces E2E-B-003) — the self-classifying proof that a daemon
 * carrying repeated session lifecycles returns its FD/handle count to BASELINE after every cycle, so a
 * daemon left up for days does not accumulate a slow leak.
 *
 * **The gap this closes, precisely.** Every other oracle in this package asks a question about ONE
 * pass: does the flow work (#20/#65/#66), is the split honest (#67/#18), does the launched pty leave a
 * residual (#68). A leak of ONE handle per session lifecycle passes all of them — one pass leaks one
 * handle, nothing notices, and every assertion is green. It is only visible as an ACCUMULATION, and only
 * something that runs the lifecycle many times over can see it. That is what this is: the daemon stays
 * UP across every cycle (`server.close()` is never called — that is #68's whole-daemon teardown, a
 * different claim), sessions are launched and stopped through the daemon's own ingress, and the
 * FD/handle tally is read between cycles.
 *
 * **The receiver of record is #63's OWN diagnostics** — {@link captureHandleReport}, the FD/handle-count
 * sampler the inspector-diagnostics slice ships. That is deliberate and is what AC2's "using the
 * diagnostics endpoint" asks for: this oracle does not invent a second way to count handles, it drives
 * the one the daemon already exposes to an operator. (#63's trigger is a `SIGUSR1` signal rather than an
 * HTTP route — its own module doc explains why: an HTTP diagnostics route would need the boot-gate-only
 * local-server-auth secret as a *request* credential, front-running deferred #57/#58 scope, or no auth
 * at all. The SAMPLER is the capability; the signal is merely its trigger, and a test needs no signal to
 * call it.)
 *
 * **What that sampler can and CANNOT see — the scope boundary, stated up front because it is the one
 * thing a reader could otherwise over-read.** {@link captureHandleReport} tallies
 * `process.getActiveResourcesInfo()`, which reports the libuv resources currently keeping the event loop
 * alive. Probed on this repo's Node (v26):
 *
 *   - a ref'd `setInterval` IS counted (`Timeout`), and a leaked connected socket IS counted
 *     (`TCPSocketWrap` climbing) — so the vectors this daemon actually leaks through are visible;
 *   - an UNREF'd handle is NOT counted — it is not keeping the loop alive;
 *   - a BARE FILE DESCRIPTOR is NOT counted. The pinned test opens 64 of them and asserts the tally
 *     moves by less than 8 — a margin for background churn, not a measurement: were fds counted at all
 *     the delta would be ~64, and the probe itself measured 0.
 *
 * So despite the "FD/handle" name this oracle asks about the REF'D-LIBUV-RESOURCE tally, which is what
 * #63's endpoint answers — no more. A raw fd leak is invisible HERE, and is exactly what #68's oracle
 * asks the kernel about directly (`fstat` on the pty master descriptor, per-fd). The two are
 * complementary rather than overlapping: #68 asks "did THIS descriptor get released?", this asks "did
 * the daemon's whole resource tally come back?". Neither subsumes the other, and this one must not be
 * read as "no fd leak of any kind".
 *
 * **The daemon's per-session TIMERS are NOT among them — every one is `.unref()`'d, so this oracle is
 * blind to them, and saying so plainly matters more than the reach it costs.** A session does accumulate
 * timers in the daemon: the pending-launch eviction timer (#33, `pending-launch.ts`), the worker
 * `setInterval` LIVENESS timer (#166, `worker-channel.ts`), the session-eviction grace timer (#173), the
 * idle-threshold timer (#41), and the close-timeout timer (`session-release.ts`). Every one of them calls
 * `.unref()` on the line after it is armed — deliberately, so that a daemon's pending bookkeeping never
 * by itself keeps the process alive. Which lands them on the wrong side of the boundary stated just
 * above: an unref'd handle is NOT keeping the event loop alive, so `getActiveResourcesInfo()` does not
 * report it, so a leaked one is INVISIBLE here. Measured, not reasoned: 22 full lifecycles driven to
 * downstream-open depth against a real daemon never put a single `Timeout` in the tally.
 *
 * **So what this oracle actually watches** is the ref'd remainder, which across THIS soak's cycle is the
 * sockets and pipes. The same run's settled tally is `{ PipeWrap: 4, TCPServerWrap: 1, TCPSocketWrap: 3 }`,
 * flat across every cycle: the daemon's own listener, the pooled loopback sockets, the worker downstream's
 * pipes. Those are real leak vectors — a `reapWorkerChannel` that failed to end a downstream, or a
 * `closeSession` that stranded an event relay's socket, shows up here as a climbing `PipeWrap` /
 * `TCPSocketWrap` — and they are what the negative control below proves the probe can see. What the soak
 * asks is therefore: *does the daemon's ref'd-resource tally come back after every session?* — plus, via
 * the `maxSessions: 1` skeleton, does the registry row itself always leave.
 *
 * That "sockets and pipes" is a fact about this CYCLE, not a claim that the daemon holds no visible timer:
 * `environments-bridge.ts` arms a ref'd `setTimeout` per in-flight work-poll hold (`workPollTimeoutMs`)
 * with no `.unref()`, and it is visible here 1:1 as `Timeout`. The soak's cycle simply never arms one — it
 * drives §4 register + SSE and never polls for work — which is why no `Timeout` appears in any reading.
 * A leaked poll waiter WOULD be caught by this oracle; it is just not on this cycle's path.
 *
 * **The honest consequence: nobody owns the daemon's unref'd timers.** #68's oracle asks the kernel about
 * one pty descriptor (`fstat`, per-fd); this one asks about the ref'd libuv tally; a leaked `.unref()`'d
 * timer falls between them and no oracle in this package would fail. That is a real gap, recorded as
 * **#238** rather than papered over — closing it needs a sampler that reads unref'd handles too, which is
 * #63's sampler's scope to widen, not this spec's to route around.
 *
 * **Why the lifecycle is still driven to FULL depth** — launch → §2 claim → worker downstream open →
 * stop. Not for the liveness timer (which, per the above, this cannot see) but because the downstream is
 * itself the socket/pipe leg: opening it is what makes `reapWorkerChannel` have something real to end,
 * and a cycle that stopped at the §2 claim would never create the resource whose release is the thing
 * most worth measuring. `stopSession` (#76) is the canonical teardown under test —
 * `consumePendingLaunch` + `reapWorkerChannel` + `closeSession` (terminal status, row dropped, relay
 * reaped).
 *
 * **Why a WARMUP precedes the baseline, and why that is measured rather than assumed.** A count taken
 * before the daemon has ever carried a session reads every ONE-TIME allocation as growth. This is not a
 * hypothetical: the same probe shows `fetch`'s undici keep-alive pool climbing to `TCPSocketWrap: 3` on
 * the first cycle and then sitting FLAT across every later one — a step, not a leak. A baseline taken
 * before that step would make the first cycle look like a leak on a faithful daemon; a baseline taken
 * after it makes "returns to baseline" a claim about the STEADY STATE, which is the claim worth making.
 * So {@link SOAK_WARMUP_CYCLES} full lifecycles run and are discarded before the baseline is read.
 *
 * **Two detectors, because a slow leak hides from either one alone.** Both are AC2's own words:
 *
 *   1. **The count returns to baseline** ({@link SOAK_CHECK.baselineReturn} / {@link SOAK_CHECK.typeGrowth})
 *      — every settled post-cycle reading is back at baseline, within {@link SOAK_BASELINE_TOLERANCE_HANDLES}.
 *      This catches magnitude. It is checked per TYPE as well as on the total, because a total alone can
 *      be MASKED: a leaked `Timeout` while a pooled socket happens to close nets to zero and reads clean.
 *      Per-type is #63's own stated design intent — its module doc names "a growing `TCPServerWrap` /
 *      `PipeWrap` / `Timeout` tally over successive samples" as the leak signal.
 *   2. **No monotonic growth** ({@link SOAK_CHECK.monotonic}) — the series never comes back DOWN and
 *      ends higher than it started ({@link isMonotonicGrowth}). This is the SLOW-leak detector, and it
 *      earns its place because it is the only one with no tolerance: a leak small enough to still sit
 *      under {@link SOAK_BASELINE_TOLERANCE_HANDLES} across a COMPRESSED run has not accumulated enough
 *      for detector 1 yet, but the climb is already on the record. A leak of one handle every five
 *      lifecycles reads `8,8,8,8,9,9,9,9` over a skeleton run — never more than +1 over baseline, so
 *      detector 1 is silent, while this one fires.
 *
 *      The predicate is NON-DECREASING-and-net-up rather than STRICTLY increasing, and that distinction
 *      is the whole detector: strict increase demands +1 on every single cycle, but a leak that fast has
 *      already cleared tolerance by cycle 3 and detector 1 catches it anyway — so a strict predicate
 *      fires only where it is redundant and is silent on every leak slower than one-per-cycle, which is
 *      the entire class it exists for.
 *
 *      That it does not flake is measured, not hoped: 20 consecutive settled cycles against a real
 *      daemon read `8` every time, `byType` identical — the settled series of a faithful daemon has no
 *      jitter at all, so any climb that never reverses is signal. (Any single downward step disqualifies
 *      it, which is what keeps transient noise out.)
 *
 * Deliberately no third, invented statistic (a regression slope, a half-vs-half mean): AC2 asks for
 * these two, and a detector nobody asked for is a flake surface with no acceptance criterion behind it.
 *
 * **"Multiple days" is the OPERATOR's lever, and the verdict never lies about it.** A soak's cost is
 * TIME, and no CI lane can spend days — but that is a reason to make the span an input, not a reason to
 * quietly claim it. {@link SoakPlan} carries both axes AC1 names — `cycles` (the "repeated session
 * lifecycles" half) and `durationMs` (the "over multiple days" half) — the drive PACES its cycles across
 * the declared duration, and {@link classifyDaemonSoak} refuses to `verified` a soak that fell short of
 * the plan it was handed. Every report then states the span it ACTUALLY achieved and carries
 * {@link SoakReport.spannedMultiDay} explicitly, so a compressed run can never be read as the multi-day
 * claim: `verified` means "no leak over the soak that ran", and the report says in words how long that
 * was. An operator arming {@link SOAK_DURATION_MS_ENV} to two days gets AC1 literally.
 *
 * **Fenced / opt-in — and the prerequisite is TIME, not infrastructure, which puts the fence in a
 * different place than every sibling.** #65/#66/#67 need a tailnet, #68 needs a spawn-capable node-pty,
 * #133 needs an API key — infrastructure a box either has or does not, which is why their whole judgment
 * sits behind `describe.skipIf`. A soak needs nothing but hours. So the split here is by DURATION rather
 * than by capability: the compressed soak is HERMETIC and gates every `test` run (`daemon-soak.test.ts`
 * drives the real daemon over loopback at {@link SOAK_SKELETON_CYCLES} cycles, with the negative control
 * beside it), and `CCCTL_E2E` + `CCCTL_E2E_SOAK` ({@link resolveSoakE2EEnv}) arms the LONG run in the
 * e2e lane. What is fenced is the span, not the judgment — and unlike its siblings, not even the drive:
 * the sampler and clock are injected seams, so the warmup / pacing / settling / classification logic is
 * all proven credential-free.
 *
 * **What is REAL here**: the daemon and its whole session-lifecycle bookkeeping (registry, pending-launch
 * records + timers, worker channels, event relays, liveness/eviction/idle timers), its launch ingress
 * (`POST /api/sessions`) and stop ingress (`POST /api/sessions/{id}/stop`) carrying the phone's own
 * bodies built by the REAL `@ccctl/web-ui` modules, the §2 bridge claim, the §4/§5 worker channel, and
 * #63's own sampler.
 *
 * **What is a STAND-IN, and why**: the `ISessionLauncher` backend and the worker — both on the far side
 * of ports the daemon calls OUT through, both necessarily so (the repo ships no packaged patched
 * worker; see the package README), and both irrelevant to this claim. The REAL backend's own FD
 * residual is #68's claim, proven by #68's oracle against its own arm; folding `CCCTL_E2E_PTY` in here
 * would conflate two arms and re-classify a claim that already has an owner.
 *
 * **The sample is PROCESS-WIDE, and that is fail-safe rather than merely tolerable.** In-process, the
 * tally covers the daemon AND the harness driving it (the stand-in worker's SSE client, the pooled fetch
 * sockets). A harness that leaked would therefore be ATTRIBUTED to the daemon — but only ever as a
 * `drift`, never as a green: noise and foreign leaks can only push the count UP, which fails. So the
 * asymmetry runs the safe way, and the negative control below is what proves the probe reports a leak
 * that is really there rather than one it imagined.
 */

import {
  captureHandleReport,
  type CcctlServer,
  type HandleSampler,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "@ccctl/server";
import { createSession } from "./bridge-wire-conformance.js";
import { connectFakeWorker } from "./one-session-harness.js";

// --- the fence (pure) ---

/** Whether the LONG soak may run, and what is missing when it may not. */
export type SoakFence = { readonly ready: true } | { readonly ready: false; readonly missing: readonly string[] };

/**
 * Resolve the long-soak fence from an environment. READY only when BOTH `CCCTL_E2E` (the shared
 * master switch every fenced oracle here honors) and `CCCTL_E2E_SOAK` (this oracle's own arm: "spend
 * real time soaking this daemon") are truthy — present and not one of the conventional OFF spellings
 * (`""` / `"0"` / `"false"` / `"no"`). Otherwise NOT ready, naming every absent var.
 *
 * Its own arm rather than a reuse of `CCCTL_E2E_TAILSCALE` (#65/#66/#67) or `CCCTL_E2E_PTY` (#68),
 * because the prerequisite is not infrastructure at all — it is an operator willing to spend the hours
 * AC1 asks for. Folding it into an existing arm would make a box with a tailnet spend a multi-day soak
 * it never asked for, every time it ran the tunnel oracles.
 *
 * Pure over the injected `env` (defaults to `process.env`) so the fence is unit-testable without
 * mutating the process environment — the caller wraps this in `describe.skipIf(!fence.ready)`.
 */
export function resolveSoakE2EEnv(env: NodeJS.ProcessEnv = process.env): SoakFence {
  const missing: string[] = [];
  if (!isTruthyFlag(env.CCCTL_E2E)) {
    missing.push("CCCTL_E2E");
  }
  if (!isTruthyFlag(env.CCCTL_E2E_SOAK)) {
    missing.push("CCCTL_E2E_SOAK");
  }
  return missing.length > 0 ? { ready: false, missing } : { ready: true };
}

/** A one-line, human-readable rendering of a {@link SoakFence} — the suite title's suffix. */
export function describeSoakFence(fence: SoakFence): string {
  return fence.ready
    ? "long-soak oracle armed (CCCTL_E2E + CCCTL_E2E_SOAK present)"
    : `long-soak oracle fenced off — missing ${fence.missing.join(", ")}`;
}

/**
 * Whether an env var reads as ON. Matches the sibling oracles' spelling exactly
 * (`pty-handle-residual.ts`, `multi-session-tunnel.ts`, `live-worker-oracle.ts`) so every fence in this
 * package agrees on what "set" means: present, and not one of the conventional OFF spellings.
 */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

// --- the plan (pure) ---

/**
 * The wall-clock AC1's "multiple days" means, taken at its LEAST generous reading: two days. "Multiple"
 * is satisfied by two, and picking the smallest honest number matters in the one direction that counts —
 * it is the bar {@link SoakReport.spannedMultiDay} reports against, so a stingier definition would let a
 * shorter run claim AC1, while a more generous one only ever under-claims a soak that did run for days.
 */
export const MULTI_DAY_MS = 2 * 24 * 60 * 60 * 1_000;

/** The env var an operator raises to buy the wall-clock span AC1 asks for. */
export const SOAK_DURATION_MS_ENV = "CCCTL_E2E_SOAK_DURATION_MS";

/** The env var an operator raises to buy more session lifecycles. */
export const SOAK_CYCLES_ENV = "CCCTL_E2E_SOAK_CYCLES";

/**
 * The fewest measured cycles that can support a verdict at all. Below this the series is too short to
 * be a TREND — the monotonic detector would be reading noise, and "returns to baseline" over one or two
 * readings says nothing about accumulation. A capture under this floor is {@link SoakVerdict}
 * `inconclusive`, never a green: the honest answer to "did it leak over a long run?" after three cycles
 * is that nobody asked.
 */
export const MIN_SOAK_CYCLES = 4;

/**
 * The measured cycles an armed soak runs when the operator named no count. Deliberately well above
 * {@link MIN_SOAK_CYCLES} — enough lifecycles that a one-handle-per-cycle leak clears
 * {@link SOAK_BASELINE_TOLERANCE_HANDLES} many times over and cannot hide under it — while still
 * finishing in seconds, so `CCCTL_E2E_SOAK=1` alone yields a real soak rather than a wait.
 */
export const DEFAULT_SOAK_CYCLES = 24;

/**
 * The wall-clock an armed soak spans when the operator named no duration: none. The cycles run back to
 * back, which is the RIGHT default — it makes the arm cheap enough to be worth setting, and the
 * cycle-axis detectors do not need pacing to work (a per-cycle leak accumulates on the cycle axis
 * whether the cycles are a second or an hour apart). The duration axis exists for AC1's literal span and
 * for a leak that is genuinely time-driven rather than lifecycle-driven; both are the operator's to buy
 * via {@link SOAK_DURATION_MS_ENV}, and the report says plainly when they did not.
 */
export const DEFAULT_SOAK_DURATION_MS = 0;

/** The cycles the HERMETIC skeleton soaks — above {@link MIN_SOAK_CYCLES}, fast enough for every CI run. */
export const SOAK_SKELETON_CYCLES = 8;

/** What a soak was ASKED to do: AC1's two axes, both declared up front so a short run cannot claim a long one. */
export interface SoakPlan {
  /** Measured session lifecycles to run (excludes the discarded {@link SOAK_WARMUP_CYCLES}). */
  readonly cycles: number;
  /** Wall-clock to spread those cycles across. `0` runs them back to back. */
  readonly durationMs: number;
}

/**
 * Resolve the operator's soak plan from an environment, falling back to {@link DEFAULT_SOAK_CYCLES} /
 * {@link DEFAULT_SOAK_DURATION_MS}. A value that is not a non-negative, finite number — `NaN` in
 * particular, which is what `Number(…)` of a mistyped var yields — falls back to the default rather
 * than propagating: `NaN` cycles would make the drive's loop run zero times and self-classify
 * `inconclusive`, which is safe but reports a missing soak instead of the misconfiguration that caused
 * it. Cycles are additionally floored at 1 so a `0` cannot silently request a soak with nothing in it.
 *
 * Pure over the injected `env` for the same reason the fence is: unit-testable without mutating the
 * process environment.
 */
export function resolveSoakPlan(env: NodeJS.ProcessEnv = process.env): SoakPlan {
  return {
    cycles: Math.max(1, Math.trunc(readNumber(env[SOAK_CYCLES_ENV], DEFAULT_SOAK_CYCLES))),
    durationMs: Math.trunc(readNumber(env[SOAK_DURATION_MS_ENV], DEFAULT_SOAK_DURATION_MS)),
  };
}

/** Read a non-negative finite number from an env var, falling back when it is absent or unusable. */
function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A one-line rendering of a {@link SoakPlan} — what this run was asked to do. */
export function describeSoakPlan(plan: SoakPlan): string {
  return `${plan.cycles} session lifecycle(s) across ${formatDuration(plan.durationMs)}`;
}

/** Render a millisecond span the way an operator reads a soak: days/hours/minutes/seconds, never bare ms. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}min`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(2)} days`;
}

// --- sampling (the receiver of record: #63's own diagnostics) ---

/**
 * Full session lifecycles run and DISCARDED before the baseline is read. Two rather than one: the first
 * absorbs the process-wide one-time steps the module doc measures (the undici keep-alive pool warming to
 * its plateau), and the second is what makes the baseline CHECKABLE rather than hoped-for — if a
 * one-time step were still landing on cycle 2, the baseline would sit above the steady state and every
 * measured cycle would read BELOW it, which is a pass. Erring toward a too-high baseline is the safe
 * direction only for false reds; the real reason for the second cycle is that one cycle cannot show
 * whether the step has finished, and two can.
 *
 * This is the ONLY thing standing between a late one-time step and a false red, and that is worth naming
 * rather than leaving implicit: a step landing on a MEASURED cycle instead of a warmup one is reported as
 * `drift` by {@link isMonotonicGrowth}, which has no tolerance and cannot tell a step from a trend. The
 * warmup is therefore load-bearing in both directions — it protects the baseline from reading high, AND
 * it is what keeps the trend detector's accepted false-positive class empirically empty. Measured: the
 * steps are done by cycle 1 and 320+ later settled readings never moved.
 */
export const SOAK_WARMUP_CYCLES = 2;

/**
 * How far a settled reading may sit above baseline before it is a leak.
 *
 * A jitter margin, not a leak allowance: it absorbs a stray transient the settle did not catch (the probe
 * shows `Immediate` / `ConnectWrap` appearing and clearing between readings), and nothing more. In
 * practice it is not even spending that — 20 consecutive settled cycles against a real daemon measured
 * ZERO jitter — so it is slack held for a slower box rather than a number tuned to fit observed noise.
 *
 * What it costs is bounded and worth stating exactly, because a tolerance is where a leak hides. A leak
 * that stays under it for the WHOLE run is invisible to {@link SOAK_CHECK.baselineReturn}; what closes
 * that is not this constant but {@link SOAK_CHECK.monotonic}, which has no tolerance and fires on a climb
 * that never reverses however slow it is. The two are complementary rather than jointly exhaustive: a
 * leak that both rises under tolerance AND reverses somewhere in the series would evade both — over a
 * COMPRESSED run. Over the multi-day run AC1 actually asks for, accumulation is linear in cycles and any
 * real leak clears this margin long before the end, which is the sense in which the armed soak, not this
 * number, is the real detector.
 */
export const SOAK_BASELINE_TOLERANCE_HANDLES = 2;

/**
 * Consecutive equal totals that mean "the count has settled". The daemon's teardown is not instantaneous
 * (`releaseLaunchedSession` is fire-and-forget, sockets close asynchronously), so a reading taken the
 * instant a stop returns catches the release IN FLIGHT and reports a residual that is merely a race —
 * the same hazard #68's `waitForResidualToSettle` guards, arriving on the aggregate rather than on one
 * fd. Three rather than two, because two consecutive equal readings happen constantly mid-transition.
 */
const SOAK_SETTLE_STABLE_READINGS = 3;

/**
 * How long to wait for a reading to settle before taking the last one anyway. Exported because the
 * fenced spec's own timeout is COMPUTED from it (`daemon-soak.e2e.test.ts` § `timeoutFor`) — this is
 * the per-cycle worst case that budget is built out of, and there is deliberately no per-drive
 * override that could put the two out of step.
 */
export const SOAK_SETTLE_TIMEOUT_MS = 5_000;

/** How often to re-read while waiting for a reading to settle. */
const SOAK_SETTLE_POLL_INTERVAL_MS = 20;

/** One settled reading of the daemon's FD/handle tally, taken from #63's own diagnostics. */
export interface SoakSample {
  /** Which measured cycle this followed. `0` is the post-warmup baseline. */
  readonly cycle: number;
  /** Total active libuv resources — AC2's "FD/handle count". */
  readonly total: number;
  /** The per-type breakdown — what a MASKED leak shows up in when the total nets to zero. */
  readonly byType: Readonly<Record<string, number>>;
}

// --- the verdict (pure) ---

/** The oracle's tri-state verdict — the same vocabulary every oracle in this package speaks. */
export type SoakVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const SOAK_CHECK = {
  plan: "soak-plan-declared (AC1)",
  lifecycles: "repeated-session-lifecycles (AC1)",
  span: "soak-span-achieved (AC1)",
  baseline: "post-warmup-baseline (AC2)",
  series: "per-cycle-series (AC2)",
  baselineReturn: "count-returns-to-baseline (AC2)",
  typeGrowth: "no-per-type-growth (AC2)",
  monotonic: "no-monotonic-growth (AC2)",
} as const;

/** Everything one soak observed — the input to the pure {@link classifyDaemonSoak}. */
export interface SoakCapture {
  /** What the soak was ASKED to run. Absent → nothing was declared, so nothing can be judged against it. */
  readonly plan?: SoakPlan | undefined;
  /** The steady-state reading taken AFTER the warmup and BEFORE the measured cycles. */
  readonly baseline?: SoakSample | undefined;
  /** One settled reading per COMPLETED measured cycle, in order. */
  readonly cycles?: readonly SoakSample[] | undefined;
  /** How many full session lifecycles actually completed — the drive's own count. */
  readonly lifecyclesCompleted?: number | undefined;
  /** Wall-clock the measured soak spanned, baseline to last reading. */
  readonly spanMs?: number | undefined;
  /** The tolerance applied; defaults to {@link SOAK_BASELINE_TOLERANCE_HANDLES}. */
  readonly toleranceHandles?: number | undefined;
  /** Why a lifecycle could not complete, when one could not — the soak did not run, so it cannot be judged. */
  readonly lifecycleFailure?: string | undefined;
}

/** One soak's verdict, the checks it violated, and why. */
export interface SoakReport {
  readonly verdict: SoakVerdict;
  /** The checks whose OBSERVED behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation, always naming the span and cycle count actually achieved. */
  readonly reason: string;
  /**
   * Whether the soak ACTUALLY spanned {@link MULTI_DAY_MS} — AC1's literal "over multiple days".
   * Reported separately from the verdict, and never folded into it, so that a `verified` compressed run
   * states what it is instead of implying a multi-day claim it did not buy. `false` on any capture that
   * did not span it, including one with no span at all.
   */
  readonly spannedMultiDay: boolean;
}

/**
 * The PURE decision — #69's two ACs, encoded (Tier A) and unit-tested credential-free.
 *
 * Ordering is load-bearing and matches this package's other classifiers: DRIFT is checked FIRST, so an
 * observed leak is never masked by a downstream gap. A count that climbed is a leak whether or not some
 * later leg went missing.
 *
 * `verified` demands that the soak actually RAN what it declared — the plan's cycles completed, each as
 * a full lifecycle, spanning the declared duration. That is what keeps AC1 structural rather than a
 * convention: a soak cut short cannot report "no leak over a long run", because it did not have one.
 */
export function classifyDaemonSoak(capture: SoakCapture): SoakReport {
  const tolerance = capture.toleranceHandles ?? SOAK_BASELINE_TOLERANCE_HANDLES;
  const cycles = capture.cycles ?? [];
  const spannedMultiDay = (capture.spanMs ?? 0) >= MULTI_DAY_MS;
  const achieved = describeAchieved(capture);

  // 1. DRIFT — contract violations actually OBSERVED. Needs only a baseline and at least one reading;
  //    a leak visible in a short series is still a leak, and reporting it beats waiting for the plan.
  const violations: string[] = [];
  if (capture.baseline !== undefined && cycles.length > 0) {
    violations.push(...findGrowth(capture.baseline, cycles, tolerance));
    if (cycles.length >= MIN_SOAK_CYCLES && isMonotonicGrowth(cycles.map((sample) => sample.total))) {
      violations.push(
        `${SOAK_CHECK.monotonic}: the handle count climbed across ${cycles.length} cycles and never came ` +
          `back down (${cycles[0]?.total} → ${cycles[cycles.length - 1]?.total}) — the settled series of a ` +
          `faithful daemon is flat, so a count that only ever rises is a slow leak, not jitter, even where ` +
          `it is still within tolerance of baseline`,
      );
    }
  }
  if (violations.length > 0) {
    return {
      verdict: "drift",
      violations,
      reason: `the daemon leaked over ${achieved}: ${violations.join("; ")}`,
      spannedMultiDay,
    };
  }

  // 2. INCONCLUSIVE — nothing drifted, but a required observation is missing or the soak fell short of
  //    what it declared. Each gap is a question this run could not ask; answering it anyway would be the
  //    fabricated green the package forbids.
  const gaps: string[] = [];
  if (capture.lifecycleFailure !== undefined) {
    gaps.push(`${SOAK_CHECK.lifecycles}: a session lifecycle could not complete (${capture.lifecycleFailure})`);
  }
  if (capture.plan === undefined) {
    gaps.push(`${SOAK_CHECK.plan}: the soak declared no plan, so there is nothing to hold it to`);
  }
  if (capture.baseline === undefined) {
    gaps.push(`${SOAK_CHECK.baseline}: no post-warmup baseline was read, so "returns to baseline" has no referent`);
  }
  if (cycles.length === 0) {
    gaps.push(`${SOAK_CHECK.series}: no cycle was ever measured`);
  } else if (cycles.length < MIN_SOAK_CYCLES) {
    gaps.push(
      `${SOAK_CHECK.series}: only ${cycles.length} cycle(s) were measured — fewer than the ` +
        `${MIN_SOAK_CYCLES} a trend needs, so this cannot speak to accumulation`,
    );
  }
  if (capture.plan !== undefined && cycles.length < capture.plan.cycles) {
    gaps.push(
      `${SOAK_CHECK.lifecycles}: the soak was cut short — ${cycles.length} of the planned ` +
        `${capture.plan.cycles} cycle(s) were measured`,
    );
  }
  if (capture.lifecyclesCompleted !== undefined && capture.lifecyclesCompleted < cycles.length) {
    gaps.push(
      `${SOAK_CHECK.lifecycles}: ${cycles.length} reading(s) were taken but only ` +
        `${capture.lifecyclesCompleted} lifecycle(s) completed — a reading with no lifecycle behind it ` +
        `measures nothing`,
    );
  }
  if (capture.spanMs === undefined) {
    gaps.push(`${SOAK_CHECK.span}: the soak's span was never recorded`);
  } else if (capture.plan !== undefined && capture.spanMs < capture.plan.durationMs) {
    gaps.push(
      `${SOAK_CHECK.span}: the soak spanned ${formatDuration(capture.spanMs)} of the declared ` +
        `${formatDuration(capture.plan.durationMs)} — it did not run for as long as it claimed to`,
    );
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not soak the daemon end-to-end: ${gaps.join("; ")}`,
      spannedMultiDay,
    };
  }

  return {
    verdict: "verified",
    violations: [],
    reason:
      `the daemon carried ${achieved} and its FD/handle count returned to baseline after every one ` +
      `(baseline ${capture.baseline?.total}, peak ${peakTotal(cycles)}, final ${cycles[cycles.length - 1]?.total}, ` +
      `tolerance ${tolerance}) with no monotonic growth — no slow leak. ` +
      (spannedMultiDay
        ? `This soak DID span multiple days (${formatDuration(capture.spanMs ?? 0)}), so AC1's span is met literally.`
        : `This soak did NOT span multiple days (${formatDuration(capture.spanMs ?? 0)} < ` +
          `${formatDuration(MULTI_DAY_MS)}): the no-leak property is verified for the soak that RAN, and the ` +
          `multi-day span AC1 names is bought by raising ${SOAK_DURATION_MS_ENV}.`),
    spannedMultiDay,
  };
}

/** A one-line rendering of what a capture actually achieved — every reason states it, verdict or not. */
function describeAchieved(capture: SoakCapture): string {
  const cycles = capture.cycles?.length ?? 0;
  return `${cycles} session lifecycle(s) spanning ${formatDuration(capture.spanMs ?? 0)}`;
}

/** The highest total in a series, or `undefined` for an empty one. */
function peakTotal(cycles: readonly SoakSample[]): number | undefined {
  return cycles.length === 0 ? undefined : Math.max(...cycles.map((sample) => sample.total));
}

/**
 * Every way a series rose above its baseline: on the TOTAL (AC2's "FD/handle count"), and on any single
 * resource TYPE (the masked leak the total cannot see — see the module doc). Reports the FIRST cycle to
 * cross, since that is the one an operator would go read the trail for.
 */
function findGrowth(baseline: SoakSample, cycles: readonly SoakSample[], tolerance: number): string[] {
  const violations: string[] = [];

  const firstOverTotal = cycles.find((sample) => sample.total - baseline.total > tolerance);
  if (firstOverTotal !== undefined) {
    violations.push(
      `${SOAK_CHECK.baselineReturn}: the handle count did not return to baseline — cycle ` +
        `${firstOverTotal.cycle} settled at ${firstOverTotal.total} against a baseline of ${baseline.total} ` +
        `(+${firstOverTotal.total - baseline.total}, tolerance ${tolerance}); peak over the soak was ` +
        `${peakTotal(cycles)}`,
    );
  }

  // Per type, over the union of every type seen — a type ABSENT from the baseline has a baseline of 0,
  // which is the point: a leak can introduce a resource type the daemon never held at rest.
  const types = new Set<string>([...Object.keys(baseline.byType), ...cycles.flatMap((s) => Object.keys(s.byType))]);
  for (const type of [...types].sort()) {
    const base = baseline.byType[type] ?? 0;
    const first = cycles.find((sample) => (sample.byType[type] ?? 0) - base > tolerance);
    if (first !== undefined) {
      violations.push(
        `${SOAK_CHECK.typeGrowth}: \`${type}\` did not return to baseline — cycle ${first.cycle} settled at ` +
          `${first.byType[type] ?? 0} against a baseline of ${base} (+${(first.byType[type] ?? 0) - base}, ` +
          `tolerance ${tolerance})`,
      );
    }
  }

  return violations;
}

/**
 * AC2's "monotonic growth", literally: the series never comes back DOWN, and ends higher than it started.
 *
 * Both halves are load-bearing. Non-decreasing ALONE would fire on a flat series (a faithful daemon's,
 * every time); net-up alone would fire on noise that rose and fell. Together they describe exactly the
 * shape a slow leak makes and a healthy daemon does not: a count that only ever climbs.
 *
 * Deliberately NOT strict increase: the module doc's detector 2 is the ONE canonical account of why, and
 * is deliberately not restated here — a restated copy is what drifts.
 *
 * **The FALSE-POSITIVE class this accepts** — stated because a detector's doc that admits only its
 * false-negatives is telling half the truth. Carrying no tolerance, this fires on ANY single upward step
 * the series does not reverse before it ends: `8,8,8,8,8,8,8,9` is `drift`, and it is indistinguishable
 * in KIND from the slow-leak exemplar `8,8,8,8,9,9,9,9`. So a late ONE-TIME allocation reads as a leak,
 * and the tail is where the "a downward step disqualifies it" defense is structurally weakest — a step on
 * the last cycle has no remaining chance to be disqualified.
 *
 * What bounds it is {@link SOAK_WARMUP_CYCLES}, which exists precisely to land the one-time steps BEFORE
 * the baseline; the measured evidence is that they are finished by the first cycle (the undici pool) with
 * nothing landing after — 320+ settled readings over 40-cycle runs never stepped once. That evidence is
 * from macOS; CI is Linux, where it has not been measured.
 *
 * It is ACCEPTED rather than engineered away because every fix reopens the hole this was built to close:
 * requiring TWO rises (a step-vs-trend discriminator) goes silent on `8,8,8,8,9,9,9,9`, which is the exact
 * leak the predicate exists for. Between a false red that gets investigated and a false green that ships a
 * leak, an oracle should choose the red.
 */
function isMonotonicGrowth(values: readonly number[]): boolean {
  if (values.length < 2) {
    return false;
  }
  const first = values[0] ?? 0;
  if ((values[values.length - 1] ?? 0) <= first) {
    return false;
  }
  return values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));
}

// --- the launched surface (stand-ins) ---

/**
 * A faithful stand-in terminal surface: alive while it is up, GONE once the daemon closes it.
 *
 * The post-close reading is not a nicety — it is what makes a stop succeed at all, and it is a rule the
 * daemon enforces rather than a convention. `session-release.ts` § `stopLaunchedSession` does not TRUST
 * `close()`: it re-reads the surface's liveness afterwards and, if that still says
 * `alive-server-owned`, throws — the stop answers `502 stop-failed` ("the surface reported a successful
 * close but is still running"). A stand-in whose liveness ignored `close()` would therefore fail every
 * stop in the soak, and the run would report `inconclusive` on a lifecycle that could not complete —
 * which is honest, but is not the question. (`launch-tunnel.ts` § `createRecordingLauncher` is exactly
 * that shape, correctly: #66's oracle launches and registers, and never stops anything.)
 *
 * The `closed` flag is PER SURFACE rather than per launcher, and that is load-bearing during a soak
 * above all: a flag hoisted into the launcher's closure would make every earlier surface read `exited`
 * the moment any later one closed — a fake quietly answering for the wrong terminal. The same trap is
 * documented at `web-ui-stop-flow.test.ts` § `fakeLauncher`, where it was a real bug.
 */
export function createSoakLauncher(): { readonly launcher: ISessionLauncher; readonly launched: () => number } {
  let launched = 0;
  return {
    launcher: {
      // Not `async`: nothing here awaits, and the port is satisfied by the promise itself. A real
      // backend shells out to tmux or forks a pty; this one only models a surface's liveness.
      launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
        launched += 1;
        let closed = false;
        return Promise.resolve({
          attachment: { attachable: true, hint: "tmux attach -t ccctl:soak" },
          liveness: (): Promise<SurfaceLiveness> => Promise.resolve(closed ? "exited" : "alive-server-owned"),
          close: (): Promise<void> => {
            closed = true;
            return Promise.resolve();
          },
        });
      },
    },
    launched: () => launched,
  };
}

/**
 * The NEGATIVE CONTROL (the `probeStandInLiveness` #134 posture this package holds): a daemon that
 * strands ONE ref'd libuv handle per session lifecycle, while everything else behaves.
 *
 * **What it is and is not a model of.** It stands in for the class this oracle can actually see — a
 * per-session ref'd resource the daemon fails to retire, the shape a stranded downstream pipe or event-
 * relay socket would make. It is NOT a model of the daemon's own `setInterval` liveness timer (#166)
 * leaking: that timer is `.unref()`'d, as are all its siblings, and per the module doc's scope boundary
 * this sampler could not see it leak. A `setInterval` is used here because it is the cheapest
 * deterministic way to hold a ref'd handle open — the control's job is to prove the PROBE's sensitivity,
 * not to replay a specific defect.
 *
 * **Why this must exist, and why the unit suite does not replace it.** The positive asserts an ABSENCE
 * ("the count came back"), and every absence-assertion has the same failure mode: it passes when the
 * probe never looked. {@link classifyDaemonSoak}'s own tests prove the classifier cannot verify
 * vacuously — but they prove it about the CLASSIFIER, over constructed readings. They say nothing about
 * whether #63's sampler, pointed at a REAL daemon on THIS box, can observe an accumulation that is
 * really there. If it could not, the positive would be green for the worst possible reason and every
 * unit test would still pass. It is the direct analogue of `pty-handle-residual.ts` §
 * `createLeakingPtyLauncher` and of `worker-idle-hold.ts`'s starved control.
 *
 * **Its surface tears down CORRECTLY, and that is the delicate part.** The temptation is to disable
 * `close()` — the way #68's control does, where the leak under test IS the teardown. Here that would
 * test the wrong thing entirely: the daemon's post-close liveness re-read would refuse the stop with
 * `502 stop-failed`, the lifecycle would throw, and the run would report `inconclusive` on a broken
 * stop instead of `drift` on a leak. So the surface really does go away; only the HANDLE stays. That is
 * also the more faithful model of the defect this oracle exists for — a slow leak is precisely the one
 * where every visible thing works and the count climbs anyway.
 *
 * A ref'd handle SPECIFICALLY, because a bare file descriptor is invisible to #63's sampler (see the
 * module doc's scope boundary) — a control that leaked one would leak undetectably and prove the
 * opposite of what it is here to prove.
 *
 * `reap()` is the caller's obligation: this leaks ON PURPOSE, so the test must clear what it stranded.
 */
export function createLeakingSoakLauncher(): {
  readonly launcher: ISessionLauncher;
  readonly leaked: () => number;
  readonly reap: () => void;
} {
  const leaked: NodeJS.Timeout[] = [];
  return {
    launcher: {
      launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
        // The defect under control: a ref'd timer per session that nothing ever clears.
        leaked.push(setInterval(() => undefined, 60_000));
        let closed = false;
        return Promise.resolve({
          attachment: { attachable: true, hint: "tmux attach -t ccctl:soak-control" },
          liveness: (): Promise<SurfaceLiveness> => Promise.resolve(closed ? "exited" : "alive-server-owned"),
          close: (): Promise<void> => {
            // The surface really goes — only the handle is stranded.
            closed = true;
            return Promise.resolve();
          },
        });
      },
    },
    leaked: () => leaked.length,
    reap: (): void => {
      while (leaked.length > 0) {
        clearInterval(leaked.pop());
      }
    },
  };
}

// --- the drive (impure) ---

/**
 * Perform ONE complete session lifecycle against the long-running daemon: launch it, let it register,
 * open its worker downstream, then stop it — everything the daemon accumulates and must retire.
 *
 * INJECTED rather than composed inside the drive, for two reasons. It is what lets the drive's own
 * mechanics — warmup, pacing, settling, classification — be proven credential-free against a FAKE
 * lifecycle (so unlike its sibling oracles, not even the drive is fenced). And the real lifecycle must
 * import `@ccctl/web-ui`, which is dependency-free plain JS with no type declarations, so its call site
 * belongs in the (untypechecked) test file rather than in this typechecked source — the placement every
 * web-ui call site in this package uses.
 *
 * A lifecycle that THROWS stops the soak: the run is reported `inconclusive` naming the failure, never
 * a green over a soak that did not happen.
 *
 * `cycle` is the measured cycle's 1-based number; the DISCARDED warmup lifecycles are handed NEGATIVE
 * numbers (`-1`, `-2`, …), so a lifecycle that logs or varies per cycle can tell a warmup from a
 * measured one. {@link createSoakLifecycle} needs neither and ignores it.
 */
export type SoakLifecycle = (cycle: number) => Promise<void>;

/** What {@link createSoakLifecycle} needs to drive one full lifecycle against a long-running daemon. */
export interface SoakLifecycleConfig {
  /** The REAL local daemon — the long-running subject. It is never torn down by the lifecycle. */
  readonly server: CcctlServer;
  /**
   * The canonical directory every cycle launches at — ONE for the whole soak, not one per cycle;
   * `daemon-soak-lifecycle.test.ts` § `canonicalCwd` is the canonical account of why.
   */
  readonly cwd: string;
  /** The account Bearer the §2 bridge leg carries. */
  readonly bearer: string;
  /**
   * Build the phone's own launch body. INJECTED because `@ccctl/web-ui` is dependency-free plain JS
   * with no type declarations, so its import cannot live in this typechecked source — the placement
   * every web-ui call site in this package uses, and the same seam #68's oracle carries.
   */
  readonly buildLaunchRequest: (cwd: string) => unknown;
  /** Build the phone's own stop body (`@ccctl/web-ui` § `stopRequest`). INJECTED, same reason. */
  readonly buildStopRequest: () => unknown;
  /** The phone's own per-session stop path (`@ccctl/web-ui` § `sessionStopPath`). INJECTED, same reason. */
  readonly stopPath: (sessionId: string) => string;
}

/**
 * Build the {@link SoakLifecycle} the drive repeats: ONE full session lifecycle against the
 * long-running daemon, driven to the depth this claim needs.
 *
 * Every leg is the real one — the phone's own launch body, the §2 bridge registration that CLAIMS the
 * launch, the §4/§5 worker channel, and the phone's own stop, which is the canonical teardown (#76)
 * that must retire the pending-launch record, the worker channel and the event relay together.
 *
 * The downstream leg is not optional depth — the module doc's "Why the lifecycle is still driven to FULL
 * depth" is the ONE canonical account of why, and is deliberately not restated here: a restated copy is
 * what drifts.
 *
 * THROWS on any leg that did not do what it claimed. {@link driveDaemonSoak} turns that into an
 * `inconclusive` naming it — never a green over a soak that did not happen.
 */
export function createSoakLifecycle(config: SoakLifecycleConfig): SoakLifecycle {
  const origin = `http://${config.server.address.host}:${config.server.address.port}`;
  return async (): Promise<void> => {
    const res = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config.buildLaunchRequest(config.cwd)),
    });
    const launched = (await res.json()) as { sessionId?: string; code?: string };
    if (res.status !== 201 || launched.sessionId === undefined) {
      // The daemon's OWN typed reason (#33) — `at-capacity` here would itself be the leak, a slot that
      // a previous cycle's stop never freed.
      throw new Error(`the launch answered ${res.status}${launched.code !== undefined ? ` (${launched.code})` : ""}`);
    }

    // The launched worker registers at the launched cwd, CLAIMING the launch. Id continuity is what
    // says the row advanced in place rather than a stranger minting a second one beside it (#66) — a
    // claim that missed would leave the launch's own pending record behind on every cycle, which is
    // precisely a leak this soak should catch rather than cause.
    const { sessionId } = await createSession(config.server, config.bearer, config.cwd);
    if (sessionId !== launched.sessionId) {
      throw new Error(`the §2 registration minted ${sessionId} rather than claiming ${launched.sessionId}`);
    }

    const worker = await connectFakeWorker({ server: config.server, sessionId });
    try {
      const stopped = await fetch(`${origin}${config.stopPath(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config.buildStopRequest()),
      });
      if (stopped.status !== 200) {
        throw new Error(`the stop answered ${stopped.status}: ${await stopped.text()}`);
      }
    } finally {
      await worker.close();
    }

    // Receiver-grounded: the daemon's OWN registry, not the stop's self-report. A 200 that left the row
    // behind is exactly the leak under test.
    if (config.server.sessions.has(sessionId)) {
      throw new Error(`the stopped session ${sessionId} is still in the daemon's registry`);
    }
  };
}

/** What {@link driveDaemonSoak} needs. Every host-touching seam is injectable so the drive is unit-testable. */
export interface SoakDriveConfig {
  /** What to run — AC1's two axes (see {@link resolveSoakPlan}). */
  readonly plan: SoakPlan;
  /** One full session lifecycle against the long-running daemon. */
  readonly lifecycle: SoakLifecycle;
  /**
   * The libuv resource sampler #63's {@link captureHandleReport} runs over. Defaults to the production
   * one (`process.getActiveResourcesInfo`); a unit test passes a fake series so the drive's mechanics
   * can be proven without a real daemon.
   */
  readonly sample?: HandleSampler | undefined;
  /** Lifecycles to run and discard before the baseline; defaults to {@link SOAK_WARMUP_CYCLES}. */
  readonly warmupCycles?: number | undefined;
  /** The clock — injected so a unit test can prove the pacing and the span without spending them. */
  readonly now?: (() => number) | undefined;
  /** The sleep — injected for the same reason. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Soak a long-running daemon and self-classify its FD/handle baseline.
 *
 * NEVER throws on a divergence or a missing leg — it returns a {@link SoakReport}, so the caller's
 * `switch` is the ONLY place a verdict becomes a pass / fail / skip. That is the package's
 * skips-never-fakes posture: a lifecycle that could not run is `inconclusive`, a count that climbed is
 * `drift`, and only a soak that ran what it declared without accumulating is `verified`.
 *
 * The daemon is never torn down here — it is the LONG-RUNNING subject, and the caller owns its
 * lifetime. Sessions come and go against it; that asymmetry is the whole point of the oracle.
 */
export async function driveDaemonSoak(config: SoakDriveConfig): Promise<SoakReport> {
  const now = config.now ?? ((): number => Date.now());
  const sleep = config.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const warmupCycles = config.warmupCycles ?? SOAK_WARMUP_CYCLES;
  const sampleDeps = config.sample !== undefined ? { sample: config.sample } : {};

  const readSettled = (cycle: number): Promise<SoakSample | undefined> =>
    settleSample(cycle, { now, sleep, sampleDeps });

  let lifecyclesCompleted = 0;
  let lifecycleFailure: string | undefined;

  const runLifecycle = async (cycle: number): Promise<boolean> => {
    try {
      await config.lifecycle(cycle);
      lifecyclesCompleted += 1;
      return true;
    } catch (error) {
      lifecycleFailure = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  // 1. WARMUP — full lifecycles, discarded. The one-time steps land here rather than in the measured
  //    series (see SOAK_WARMUP_CYCLES).
  for (let cycle = 1; cycle <= warmupCycles; cycle += 1) {
    if (!(await runLifecycle(-cycle))) {
      return classifyDaemonSoak({ plan: config.plan, lifecycleFailure, spanMs: 0 });
    }
  }

  // 2. BASELINE — the steady state everything after is judged against.
  const baseline = await readSettled(0);
  const startedAtMs = now();

  // 3. The measured soak — one settled reading per cycle, paced across the declared duration.
  const intervalMs = config.plan.cycles > 0 ? config.plan.durationMs / config.plan.cycles : 0;
  const cycles: SoakSample[] = [];
  for (let cycle = 1; cycle <= config.plan.cycles; cycle += 1) {
    if (!(await runLifecycle(cycle))) {
      break;
    }
    const sample = await readSettled(cycle);
    if (sample !== undefined) {
      cycles.push(sample);
    }
    // Pace to the cycle's slot on the declared wall-clock. Measured from the soak's start rather than
    // slept per cycle, so the work each cycle does is absorbed by its own slot and the total span lands
    // on the declared duration instead of drifting past it by the sum of the cycles' own durations.
    const dueAtMs = startedAtMs + intervalMs * cycle;
    const waitMs = dueAtMs - now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  const capture: SoakCapture = {
    plan: config.plan,
    lifecyclesCompleted,
    cycles,
    spanMs: Math.max(0, now() - startedAtMs),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(lifecycleFailure !== undefined ? { lifecycleFailure } : {}),
  };
  return classifyDaemonSoak(capture);
}

/**
 * Re-read #63's diagnostics until the total holds steady for {@link SOAK_SETTLE_STABLE_READINGS}
 * consecutive readings, then return the last one. Returns `undefined` only when the sampler itself
 * failed — an `inconclusive` gap, never a guess.
 *
 * Returning the last reading when the deadline passes rather than failing is what keeps a real leak a
 * leak: a count that never settles is a count still climbing, and the classifier reads that final,
 * elevated reading as the `drift` it is. So the timeout costs time only on a run that is already
 * failing.
 */
async function settleSample(
  cycle: number,
  deps: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly sampleDeps: { readonly sample?: HandleSampler };
  },
): Promise<SoakSample | undefined> {
  const deadline = deps.now() + SOAK_SETTLE_TIMEOUT_MS;
  let stable = 1;
  let previous = takeSample(cycle, deps.sampleDeps);
  if (previous === undefined) {
    return undefined;
  }
  while (stable < SOAK_SETTLE_STABLE_READINGS && deps.now() < deadline) {
    await deps.sleep(SOAK_SETTLE_POLL_INTERVAL_MS);
    const next = takeSample(cycle, deps.sampleDeps);
    if (next === undefined) {
      return previous;
    }
    stable = next.total === previous.total ? stable + 1 : 1;
    previous = next;
  }
  return previous;
}

/** One reading of #63's own FD/handle diagnostics, stamped with the cycle it followed. */
function takeSample(cycle: number, sampleDeps: { readonly sample?: HandleSampler }): SoakSample | undefined {
  const outcome = captureHandleReport(sampleDeps);
  return outcome.ok ? { cycle, total: outcome.report.total, byType: outcome.report.byType } : undefined;
}
