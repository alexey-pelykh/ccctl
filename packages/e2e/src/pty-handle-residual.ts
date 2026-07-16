// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The REAL `node-pty` HANDLE-RESIDUAL oracle (#68, traces E2E-B-003) — the fenced,
 * self-classifying proof that a session launched through the daemon's own ingress onto the REAL
 * owned-pty backend (#30) leaves NO residual: its pty master file descriptor and its child process
 * are both gone once the daemon tears the session down.
 *
 * **The gap this closes, precisely.** `@ccctl/server`'s owned-pty backend puts its one impure edge
 * — spawning a pty — behind an injectable {@link PtySpawner} seam, and `session-launcher-pty.test.ts`
 * drives that seam with an IN-MEMORY FAKE (its own header: "hermetically, with an in-memory fake pty
 * and NO real pty / no `node-pty`"). That is the right call for a unit suite and it proves the
 * ORCHESTRATION — kill, escalate, reap, idempotent close. What it structurally CANNOT prove is that
 * the orchestration's promises hold against the REAL native binding: a fake `kill()` that fires a
 * synthetic `onExit` proves the backend *believes* the child is reaped, never that the OS agrees.
 * "The pty fd is released and the child is reaped" is a claim about the operating system, and only a
 * real pty can be asked. Every fenced oracle in this package exists for a variant of that gap; this
 * one is the RUNTIME RESIDUAL the package README has been naming as #68's since #66 ("the real
 * backend's surface + FD residual is #68's job").
 *
 * **Receiver-of-record: the OS, never node-pty.** Every reading here is taken from the kernel's own
 * answer about the handle, not from the handle's self-report ({@link readHandleState}):
 *
 *   - the CHILD is read with `process.kill(pid, 0)` — a pure existence probe that signals nothing;
 *   - the FD is read with `fstatSync(fd)` on the pty MASTER descriptor the real handle exposes.
 *
 * **`ESRCH` is proof of REAPING, not merely of exit — and that distinction is the whole point.** A
 * child that has exited but has NOT been reaped is a ZOMBIE, and a zombie still occupies its pid:
 * `kill(pid, 0)` on one SUCCEEDS. So "the child exited" and "the child was reaped" are different
 * facts, and only the second is what AC2 asks for and what keeps a long-lived daemon from
 * accumulating dead entries. `ESRCH` — the pid is gone from the process table — is available
 * precisely because the parent reaped it. An oracle that asserted merely "the child stopped running"
 * would pass against a daemon that leaks a zombie per session.
 *
 * **The self-guard is structural, not an extra test** (the `probeStandInLiveness` #134 posture this
 * package holds everywhere). A residual check answers "is it gone?", and the failure mode of any
 * such check is a probe that says "gone" because it never looked. So {@link classifyPtyHandleResidual}
 * cannot return `verified` unless the SAME probe, against the SAME pid and fd, read the handle as
 * PRESENT while the session was up and as GONE after teardown. A probe stuck on "gone" fails the
 * at-launch reading (AC2's "opened on launch" is a claim under test, not a precondition); a probe
 * stuck on "present" fails the after-teardown reading. Neither can reach `verified`, so the positive
 * is never vacuous — the two readings must DISAGREE, and that disagreement is the evidence.
 *
 * **A recycled fd number is not a leak, and the identity is what tells them apart.** POSIX hands out
 * the lowest free descriptor, so the integer that WAS the pty master is a prime candidate for the
 * next socket this process opens — and a bare "is fd 12 open?" after teardown would read that
 * reuse as a leak and fail a faithful daemon. So each reading records the fd's IDENTITY
 * (`dev:rdev:ino`) and a leak is only ever declared when the descriptor is still open AND still
 * points at the SAME object it did at launch. A different identity means the original was released
 * and its number recycled — which is a pass, and is reported as one.
 *
 * **What is REAL here**: the `node-pty` native binding, the pty it spawns, the child process in it,
 * the pty master fd, the daemon's launch ingress (`POST /api/sessions`, the phone's own body built
 * by the REAL `@ccctl/web-ui` module), the pending-launch bookkeeping, the registry, the launcher's
 * whole close/kill/escalate/reap orchestration, and the daemon's real shutdown teardown path
 * (`server.close()` → `releaseLaunchedSessions` → `releaseLaunchedSession` → the pty's `close()`).
 *
 * **What is a STAND-IN, and why it must be**: the WORKER the pty runs ({@link WORKER_FILE}). The repo
 * ships no packaged patched worker (see the package README), so there is nothing to run that could
 * ever register over §2 — and #68 does not need one to exist. Its ACs are about the FD/handle
 * RESIDUAL, not about registration (that is #66's claim, proven by its own oracle). The backend's own
 * {@link WorkerCommandFactory} seam exists for exactly this: it "asserts NOTHING about the
 * patched-claude CLI; it owns only the pty orchestration". So the worker is a real, benign,
 * long-lived POSIX process — which is all a real fd and a real reapable child require. Swapping in
 * the packaged patched worker later needs no churn to this oracle's fence, classifier, or ACs.
 *
 * **Fenced / opt-in, on its OWN arm.** The prerequisite is neither a tailnet (#65/#66/#67) nor an API
 * key (#133) but a real, SPAWN-CAPABLE `node-pty` on this box — so this carries its own arm,
 * `CCCTL_E2E` + `CCCTL_E2E_PTY` ({@link resolvePtyE2EEnv}). That the arm is genuinely separate is not
 * a style choice; it is forced by this repo's own install posture — and a default checkout cannot
 * spawn a pty on EITHER platform, for two DIFFERENT reasons. node-pty resolves its binding
 * `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>` (`lib/utils.js` §
 * `loadNativeModule`), and its `install` is `node scripts/prebuild.js || node-gyp rebuild`, where
 * `prebuild.js` ONLY probes for the prebuild directory (present → `exit 0`, absent → `exit 1`):
 *
 *   1. **Linux** — node-pty ships NO Linux prebuild, so `prebuild.js` exits 1 and `node-gyp rebuild`
 *      is what would produce `build/Release`. `pnpm-workspace.yaml`'s `allowBuilds: node-pty: false`
 *      blocks it, so the binding cannot even LOAD on the `ubuntu-latest` CI runners. This is the arm
 *      `allowBuilds` governs.
 *   2. **darwin** — a prebuild IS shipped, so `prebuild.js` exits 0, `node-gyp` NEVER runs (the `||`
 *      short-circuits), and the binding loads fine. But the shipped
 *      `prebuilds/darwin-<arch>/spawn-helper`
 *      is mode `644` — NOT executable — and NO node-pty script ever chmods it (`prebuild.js` only
 *      probes; `post-install.js` touches `build/Release` + win32's `conpty.dll` only; the package
 *      contains no `chmod` at all). So every spawn fails with `posix_spawnp failed`. Flipping
 *      `allowBuilds` does NOT fix this — it is neither necessary nor sufficient here, since the script
 *      it unblocks exits before `node-gyp` and would not have chmodded anything anyway. The actual
 *      lever is `chmod +x` on that prebuilt helper (the package README carries the runbook).
 *
 * So on a default checkout — CI included — this oracle CANNOT run, which is exactly why it must never
 * be in the credential-free lane: `describe.skipIf` skips it when the arm is absent. And when the arm
 * IS set but the binding still cannot spawn, the drive self-classifies `inconclusive` — a runtime-skip
 * naming the typed failure the daemon itself reported — never a fabricated green. The fence +
 * classifier LOGIC is proven credential-free in the `test` lane (`pty-handle-residual.test.ts`), so
 * what is fenced here is the BINDING, not the judgment.
 *
 * **POSIX-only, by construction rather than by omission.** The claim is about a pty MASTER FD, and
 * only node-pty's unix backend has one — a Windows ConPTY handle exposes no `fd`, and `kill(pid, 0)`
 * / `fstat` do not carry the same meanings there. A handle with no readable master fd is therefore
 * `inconclusive` ({@link PTY_RESIDUAL_CHECK.masterFd}), not a failure: the oracle says "I cannot ask
 * this question here" rather than answering it wrongly.
 */

import { fstatSync } from "node:fs";
import {
  createPtySessionLauncher,
  defaultPtySpawner,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchedSession,
  type OwnedPty,
  type PtySpawner,
} from "@ccctl/server";

// --- the fence (pure) ---

/** Whether the real-pty oracle may run, and what is missing when it may not. */
export type PtyFence = { readonly ready: true } | { readonly ready: false; readonly missing: readonly string[] };

/**
 * Resolve the real-pty-oracle fence from an environment. READY only when BOTH `CCCTL_E2E` (the
 * shared credentialed-wave master switch every fenced oracle here honors) and `CCCTL_E2E_PTY` (this
 * oracle's own arm: "a real, spawn-capable `node-pty` is available on this box") are truthy —
 * present and not one of the conventional OFF spellings (`""` / `"0"` / `"false"` / `"no"`).
 * Otherwise NOT ready, naming every absent var.
 *
 * Its own arm rather than a reuse of `CCCTL_E2E_TAILSCALE` (#65/#66/#67) or the live-worker oracle's
 * `CCCTL_SDK_URL` + `ANTHROPIC_API_KEY` (#133), because the prerequisite is a genuinely different
 * piece of infrastructure: a native binding that both loads AND can spawn. Folding it into an
 * existing arm would make a box with a tailnet claim a pty it may not have — and, worse, make the
 * absence of one look like a tunnel failure.
 *
 * Pure over the injected `env` (defaults to `process.env`) so the fence is unit-testable without
 * mutating the process environment — the caller wraps this in `describe.skipIf(!fence.ready)` so an
 * unfenced run SKIPS (never fails, never fakes) and never enters the credential-free CI lane.
 */
export function resolvePtyE2EEnv(env: NodeJS.ProcessEnv = process.env): PtyFence {
  const missing: string[] = [];
  if (!isTruthyFlag(env.CCCTL_E2E)) {
    missing.push("CCCTL_E2E");
  }
  if (!isTruthyFlag(env.CCCTL_E2E_PTY)) {
    missing.push("CCCTL_E2E_PTY");
  }
  return missing.length > 0 ? { ready: false, missing } : { ready: true };
}

/** A one-line, human-readable rendering of a {@link PtyFence} — the suite title's suffix. */
export function describePtyFence(fence: PtyFence): string {
  return fence.ready
    ? "real-pty oracle armed (CCCTL_E2E + CCCTL_E2E_PTY present)"
    : `real-pty oracle fenced off — missing ${fence.missing.join(", ")}`;
}

/**
 * Whether an env var reads as ON. Matches the sibling oracles' spelling exactly (`multi-session-tunnel.ts`,
 * `live-worker-oracle.ts`) so every fence in this package agrees on what "set" means: present, and not
 * one of the conventional OFF spellings.
 */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

// --- the drive's timings (declared first: the worker stand-in below DERIVES from them) ---

/**
 * How long the drive waits for the daemon's teardown to CONVERGE. It must wait at all — rather than
 * read immediately after `await server.close()` — because the release is deliberately
 * fire-and-forget: `releaseLaunchedSessions` (`ui-session-launch.ts`) calls
 * `void releaseLaunchedSession(launched)` and returns `void`, and `close()` never awaits it. So the
 * reaping is genuinely in flight when `close()` resolves, and a same-tick read would report a
 * residual that is merely a race. Generous, because it only ever costs time on a run that is about to
 * FAIL: the polling loop exits the instant both the child and the fd are gone, which on a healthy
 * daemon is a few milliseconds.
 *
 * This is also the drive's TAIL, and therefore the floor {@link WORKER_ARGS}' sleep is derived from —
 * see there for why that coupling must be computed rather than merely documented.
 */
export const REAP_CONVERGENCE_TIMEOUT_MS = 10_000;

/** How often the drive re-reads the OS while waiting for teardown to converge. */
const REAP_POLL_INTERVAL_MS = 25;

/**
 * How many times the stand-in worker must outlive the drive's own tail
 * ({@link REAP_CONVERGENCE_TIMEOUT_MS}). 3× is slack for a loaded box, not a magic number: the sleep
 * only has to survive the worst case (a leaking daemon polling the window to its deadline), and every
 * healthy run settles in milliseconds and never approaches it. Bigger would only lengthen the stray a
 * mid-flight abort leaves behind.
 */
export const WORKER_SLEEP_HEADROOM = 3;

/** The stand-in worker's sleep, in whole seconds — {@link WORKER_SLEEP_HEADROOM}× the drive's tail. */
export const WORKER_SLEEP_SECONDS = Math.ceil((REAP_CONVERGENCE_TIMEOUT_MS / 1_000) * WORKER_SLEEP_HEADROOM);

// --- the worker stand-in ---

/**
 * The executable the real pty runs. `/bin/sh` is mandated by POSIX at this exact path, so it needs no
 * lookup and cannot be the reason a run fails — which matters, because a worker that is missing would
 * surface as `worker-not-found` and be indistinguishable, to an operator reading the verdict, from
 * the pty backend being broken. See the module doc for why the worker is a stand-in at all.
 */
export const WORKER_FILE = "/bin/sh";

/**
 * The stand-in worker's argv. `exec` is load-bearing twice over: it makes the shell REPLACE itself
 * with `sleep`, so (a) the pid node-pty reports — the one the backend reaps and this oracle probes —
 * is the pid of the process actually running, with no shell wrapper standing between the signal and
 * its target, and (b) no grandchild survives the reap to linger as a stray. The sleep is long enough
 * that the child is unambiguously alive when read at launch (no exit race to mistake for a defect),
 * and short enough that a run abandoned mid-flight leaves nothing behind for more than a moment.
 * `sleep` terminates on the polite SIGHUP the backend sends first, so teardown exercises the normal
 * path rather than the escalation (which is #30's own unit-tested concern, not this oracle's).
 *
 * **The duration has a FLOOR, and it is the drive's own tail — which is why it is DERIVED rather than
 * written down.** This is the same teardown-attribution confound {@link PTY_REGISTRATION_TIMEOUT_MS}
 * guards, arriving from the other side. A `sleep` that expired BEFORE the after-teardown reading would
 * be reaped — and its master fd closed — by node-pty on the child's OWN exit, and the drive would then
 * read a clean `verified` while attributing to the daemon a teardown it never performed. A LEAKING
 * daemon would pass. So the sleep must outlast the WHOLE drive, whose tail is bounded by
 * {@link REAP_CONVERGENCE_TIMEOUT_MS} — and a leaking daemon is precisely the run that polls that
 * window to its deadline rather than settling in milliseconds.
 *
 * A hard-coded `30` would satisfy that today and silently stop satisfying it the moment someone raised
 * the convergence window — and the reopened hole is invisible, because it fails as a GREEN. So the
 * floor is not documented and hoped for, it is COMPUTED from the constant it depends on
 * ({@link WORKER_SLEEP_HEADROOM} × the window). Raising the window now raises the sleep with it.
 *
 * The one coupling this cannot enforce is a CALLER passing a
 * {@link PtyResidualDriveConfig.reapTimeoutMs} LARGER than this sleep — that would reopen the hole
 * from the outside. No caller does: the positive path takes the default, and the negative control
 * passes a deliberately SMALLER one ({@link LEAK_CONTROL_REAP_TIMEOUT_MS}), which is the safe
 * direction. A future caller wanting a longer window must raise {@link REAP_CONVERGENCE_TIMEOUT_MS}
 * (which carries the sleep with it) rather than override past it.
 */
export const WORKER_ARGS: readonly string[] = ["-c", `exec sleep ${WORKER_SLEEP_SECONDS}`];

/**
 * The registration window the daemon is given for this oracle's drive — raised far above the 10s
 * product default, to keep the ghost-reaper from stealing the teardown this oracle is measuring.
 *
 * The reason is specific to #68 and worth stating plainly, because the default would mostly work and
 * silently mean something else when it did not. The stand-in worker is a `sleep`; it NEVER registers
 * over §2, by design (the repo ships no packaged patched worker — see the module doc). So the
 * daemon's pending-launch eviction timer (`pending-launch.ts` § `evictPendingLaunch`, #33) is
 * guaranteed to fire on a launch this oracle makes, and firing means it tears the pty down ITSELF.
 * The drive completes in milliseconds and would ordinarily beat a 10s timer — but "ordinarily" is
 * the problem: on a loaded box the eviction could reap the child FIRST, and the drive would then read
 * a clean `verified` while attributing to the SHUTDOWN path a teardown the GHOST-REAPER actually
 * performed. Both paths funnel through `releaseLaunchedSession`, so the reading is identical and the
 * confound is invisible — a shutdown leak would pass, masked by the reaper having cleaned up first.
 * Raising the window past any plausible drive duration means only one teardown can have run: the one
 * under test.
 *
 * Distinct from `launch-tunnel.ts` § `LAUNCH_REGISTRATION_TIMEOUT_MS` despite the coinciding value —
 * that one keeps a SLOW TAILNET from evicting a launch mid-drive; this one keeps the reaper from
 * pre-empting the very teardown being measured. Same knob, different hazard, so the rationale lives
 * with each rather than a shared magic number whose doc discusses tunnels.
 */
export const PTY_REGISTRATION_TIMEOUT_MS = 120_000;

// --- observing the real spawn ---

/** What the real spawn yielded, as read off the handle it returned. */
export interface ObservedSpawn {
  /** The child's pid — the reified "there is a real process here" the backend reaps. */
  readonly pid: number;
  /**
   * The pty MASTER file descriptor, when the handle exposes one. Absent on a Windows ConPTY handle,
   * which has no master fd — read as `inconclusive`, never as a failure (see the module doc).
   */
  readonly fd?: number | undefined;
}

/**
 * Read the pty master fd off a real `node-pty` handle. Structural rather than typed, and
 * deliberately so: the backend's own {@link OwnedPty} seam declares only `pid` / `onExit` / `kill`,
 * because it is defined to carry NO dependency on `node-pty` (that independence is what lets its unit
 * suite run against a plain in-memory fake). The real unix handle carries `fd` all the same. Reading
 * it structurally lets this oracle observe the master descriptor WITHOUT widening the backend's port
 * to suit a test — the port stays honest about what it needs, and the oracle takes what the real
 * implementation happens to offer. Anything that is not a plausible descriptor reads as absent.
 */
function readMasterFd(pty: OwnedPty): number | undefined {
  const fd = (pty as { readonly fd?: unknown }).fd;
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : undefined;
}

/** A {@link PtySpawner} that delegates to a real one and records what the real spawn produced. */
export interface ObservingSpawner {
  /** The spawner to hand the launcher — the REAL edge, merely observed. */
  readonly spawn: PtySpawner;
  /** What the real spawn yielded, or `undefined` if it never got that far. */
  readonly observed: () => ObservedSpawn | undefined;
}

/**
 * Wrap a real {@link PtySpawner} so the handle it returns can be read for its pid + master fd, then
 * hand it to the launcher UNCHANGED.
 *
 * A wrapper rather than "pass no spawner and let the launcher default": `createPtySessionLauncher`
 * builds its own {@link defaultPtySpawner} internally and never surfaces the handle, so there would
 * be no way to learn WHICH fd to probe — and probing "some fd" is not probing the launched session's
 * fd. The delegate is {@link defaultPtySpawner} itself, the very function the launcher would have
 * constructed, so the code path under test is identical: this observes the real edge, it does not
 * substitute for it.
 */
export function createObservingPtySpawner(inner: PtySpawner = defaultPtySpawner()): ObservingSpawner {
  let observed: ObservedSpawn | undefined;
  return {
    spawn: async (file, args, options) => {
      const pty = await inner(file, args, options);
      observed = { pid: pty.pid, fd: readMasterFd(pty) };
      return pty;
    },
    observed: () => observed,
  };
}

/**
 * The REAL owned-pty launcher, observed — `createPtySessionLauncher` wired to the real
 * {@link defaultPtySpawner} (through {@link createObservingPtySpawner}) and the stand-in worker
 * command. This is the backend the daemon is given; nothing about its orchestration is faked.
 */
export function createObservedPtyLauncher(inner?: PtySpawner): {
  readonly launcher: ISessionLauncher;
  readonly observed: () => ObservedSpawn | undefined;
} {
  const spawner = createObservingPtySpawner(inner);
  return {
    launcher: createPtySessionLauncher({
      workerCommand: () => [WORKER_FILE, ...WORKER_ARGS],
      spawn: spawner.spawn,
    }),
    observed: spawner.observed,
  };
}

/**
 * The NEGATIVE CONTROL (the `probeStandInLiveness` #134 posture this package holds): the SAME real
 * pty backend, spawning a SAME real child on a SAME real pty — with its teardown DISABLED. `close()`
 * is a no-op, so the child is never signalled and the master fd is never released.
 *
 * **Why this must exist, and why the unit suite does not replace it.** The positive run asserts an
 * ABSENCE ("no residual"), and every absence-assertion has the same failure mode: it passes when the
 * probe never looked. `classifyPtyHandleResidual`'s own tests prove the classifier cannot verify
 * vacuously — but they prove it about the CLASSIFIER, over constructed readings. They say nothing
 * about whether `readHandleState`, pointed at a REAL pid and a REAL fd on THIS box, can actually
 * observe a residual that is really there. If it could not — a probe that always read `ESRCH`/`EBADF`
 * because it was asking wrongly — the positive would be green for the worst possible reason, and
 * every unit test would still pass. This control is the only thing that closes that gap: it proves
 * the same probe, in the same run, on the same box, DOES report a leak when a leak exists. So the
 * positive's "gone" is a real state change rather than the probe's default answer.
 *
 * It is the direct analogue of `worker-idle-hold.ts`'s starved control, which reproduces the
 * pre-#166 behavior to prove its stand-in does record a drop.
 *
 * `reap()` is the caller's obligation: this launcher leaks ON PURPOSE, so the test must kill the
 * child it stranded. It is uncatchable (`SIGKILL`) because the whole point of the control is a
 * teardown that does not work, and safe on an already-gone child.
 */
export function createLeakingPtyLauncher(inner?: PtySpawner): {
  readonly launcher: ISessionLauncher;
  readonly observed: () => ObservedSpawn | undefined;
  readonly reap: () => void;
} {
  const real = createObservedPtyLauncher(inner);
  return {
    launcher: {
      async launch(options): Promise<LaunchedSession> {
        const session = await real.launcher.launch(options);
        return {
          attachment: session.attachment,
          liveness: () => session.liveness(),
          // The defect under control: teardown that tears nothing down.
          close: (): Promise<void> => Promise.resolve(),
        };
      },
    },
    observed: real.observed,
    reap: (): void => {
      const pid = real.observed()?.pid;
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone — nothing to reap, which is the outcome this wanted anyway.
        }
      }
    },
  };
}

/**
 * The convergence window the NEGATIVE CONTROL waits. Short on purpose, and the brevity is sound
 * rather than a shortcut: the control's `close()` is a no-op, so there is no teardown in flight and
 * nothing to converge to — the residual is immediate and permanent. Waiting the full
 * {@link REAP_CONVERGENCE_TIMEOUT_MS} would only make the suite slower to reach a verdict it can
 * already read. (The positive path keeps the generous window, where the wait is real.)
 */
export const LEAK_CONTROL_REAP_TIMEOUT_MS = 1_000;

// --- reading the OS (the receiver of record) ---

/** One reading of the launched handle, taken from the OS itself — never from node-pty's self-report. */
export interface HandleReading {
  /**
   * The OS still has this pid. `false` ONLY on `ESRCH` — the pid is gone from the process table,
   * which is available precisely because the parent REAPED it (a zombie would still answer). See the
   * module doc: this is the difference between "exited" and "reaped", and AC2 asks for the latter.
   */
  readonly childPresent: boolean;
  /** The errno when the child probe did not succeed — `ESRCH` (reaped) or `EPERM` (present, not ours). */
  readonly childErrno?: string | undefined;
  /** `fstat(fd)` succeeded — the descriptor is open in this process. */
  readonly fdOpen: boolean;
  /** The errno when it did not — `EBADF` means the descriptor was released. */
  readonly fdErrno?: string | undefined;
  /**
   * WHAT the descriptor points at (`dev:rdev:ino`) — the identity that tells a genuine leak from a
   * recycled fd number (see the module doc). Absent when the fd is not open.
   */
  readonly fdIdentity?: string | undefined;
  /** Whether the descriptor is a character device — a pty master is one; absent when not open. */
  readonly fdCharacterDevice?: boolean | undefined;
}

/**
 * Read the OS's own answer about a launched handle: is the child still in the process table, and is
 * the master fd still open (and pointing at what)?
 *
 * `EPERM` is read as PRESENT, and that is deliberate rather than defensive: it means the pid EXISTS
 * but is not ours to signal, so the process table still holds it — it has not been reaped. Reading it
 * as absent would let a leak that changed ownership pass as a clean reap. `ESRCH` is the only errno
 * that means gone.
 */
export function readHandleState(pid: number, fd: number): HandleReading {
  let childPresent = false;
  let childErrno: string | undefined;
  try {
    // Signal 0 performs the error checks but sends nothing — a pure existence probe.
    process.kill(pid, 0);
    childPresent = true;
  } catch (error) {
    childErrno = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (childErrno === "EPERM") {
      childPresent = true;
    }
  }

  let fdOpen = false;
  let fdErrno: string | undefined;
  let fdIdentity: string | undefined;
  let fdCharacterDevice: boolean | undefined;
  try {
    const stat = fstatSync(fd);
    fdOpen = true;
    fdIdentity = `${stat.dev}:${stat.rdev}:${stat.ino}`;
    fdCharacterDevice = stat.isCharacterDevice();
  } catch (error) {
    fdErrno = (error as NodeJS.ErrnoException).code ?? "unknown";
  }

  return { childPresent, childErrno, fdOpen, fdErrno, fdIdentity, fdCharacterDevice };
}

// --- the verdict (pure) ---

/** The oracle's tri-state verdict — the same vocabulary every fenced oracle in this package speaks. */
export type PtyResidualVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const PTY_RESIDUAL_CHECK = {
  backend: "real-pty-spawn (AC1)",
  launch: "daemon-launch-ingress (AC1)",
  listed: "session-listed (AC1)",
  masterFd: "pty-master-fd (AC2)",
  fdOpened: "fd-open-on-launch (AC2)",
  childLive: "child-live-on-launch (AC2)",
  fdReleased: "fd-released-on-teardown (AC2)",
  childReaped: "child-reaped-on-teardown (AC2)",
} as const;

/** Everything one drive observed — the input to the pure {@link classifyPtyHandleResidual}. */
export interface PtyResidualCapture {
  /** What the REAL spawn produced. Absent → the real backend never brought a pty up. */
  readonly spawned?: ObservedSpawn | undefined;
  /** The daemon's own answer to the phone's launch (`POST /api/sessions`). */
  readonly launchStatus?: number | undefined;
  /** The typed `code` the daemon reported when the launch failed — why the real backend could not spawn. */
  readonly launchFailure?: string | undefined;
  /** The session id the daemon minted, read from its OWN 201 body. */
  readonly sessionId?: string | undefined;
  /** The status the daemon's OWN list reported for the launched session. */
  readonly listedStatus?: string | undefined;
  /** The OS's reading while the session is UP — the self-guard half (see the module doc). */
  readonly atLaunch?: HandleReading | undefined;
  /** The OS's reading after the daemon's own teardown ran to convergence. */
  readonly afterTeardown?: HandleReading | undefined;
  /** Whether the real teardown path was actually driven. */
  readonly teardownDriven?: boolean | undefined;
}

/** One drive's verdict, the checks it violated, and why. */
export interface PtyResidualReport {
  readonly verdict: PtyResidualVerdict;
  /** The checks whose OBSERVED behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation: what verified, what drifted, or what was never captured. */
  readonly reason: string;
}

/**
 * The PURE decision — #68's two ACs, encoded (Tier A) and unit-tested credential-free.
 *
 * Ordering is load-bearing and matches this package's other classifiers: DRIFT is checked FIRST, so a
 * present-but-wrong observation is never masked by a downstream gap. A leaked fd is a leak whether or
 * not some later leg went missing.
 *
 * `verified` demands BOTH readings and demands they DISAGREE — present at launch, gone after
 * teardown. That is what makes the positive non-vacuous rather than the assertion of a probe that
 * never looked; the module doc spells out why a residual check needs exactly this guard.
 */
export function classifyPtyHandleResidual(capture: PtyResidualCapture): PtyResidualReport {
  const violations: string[] = [];

  // 1. DRIFT — contract violations actually OBSERVED.

  // AC1: a real pty came up, but the daemon's own ingress disagreed. A spawn WITH a non-201 is a
  // genuine contradiction (a surface exists that the daemon says it never launched); a non-201 with
  // NO spawn is just the backend being unavailable, which is an inconclusive gap below, not a drift.
  if (capture.spawned !== undefined && capture.launchStatus !== undefined && capture.launchStatus !== 201) {
    violations.push(
      `${PTY_RESIDUAL_CHECK.launch}: a real pty was spawned but the daemon answered ${capture.launchStatus}` +
        `${capture.launchFailure !== undefined ? ` (${capture.launchFailure})` : ""} — a surface exists that the launch denies`,
    );
  }

  // AC2, "opened on launch" — a claim under test, not a precondition, and the self-guard's live half.
  if (capture.atLaunch !== undefined) {
    if (!capture.atLaunch.childPresent) {
      violations.push(
        `${PTY_RESIDUAL_CHECK.childLive}: the launched child was already gone at launch ` +
          `(${capture.atLaunch.childErrno ?? "?"}) — nothing was ever opened to reap`,
      );
    }
    if (!capture.atLaunch.fdOpen) {
      violations.push(
        `${PTY_RESIDUAL_CHECK.fdOpened}: the pty master fd was not open at launch (${capture.atLaunch.fdErrno ?? "?"})`,
      );
    } else if (capture.atLaunch.fdCharacterDevice === false) {
      // An open fd that is not a character device is not a pty master — the backend handed back a
      // descriptor onto something else entirely, and every later reading about "the pty's fd" would
      // be about the wrong object.
      violations.push(`${PTY_RESIDUAL_CHECK.fdOpened}: the launched fd is open but is NOT a character device`);
    }
  }

  // AC2, "closed/reaped on teardown" — THE RESIDUAL.
  if (capture.afterTeardown !== undefined) {
    if (capture.afterTeardown.childPresent) {
      violations.push(
        `${PTY_RESIDUAL_CHECK.childReaped}: the child survived the daemon's teardown — it is still in the ` +
          `process table${capture.afterTeardown.childErrno === "EPERM" ? " (EPERM: alive, no longer ours)" : ""}`,
      );
    }
    // A leak ONLY when the descriptor is still open AND still points at the SAME object. A different
    // identity means the original WAS released and its number recycled — a pass (see the module doc).
    if (
      capture.afterTeardown.fdOpen &&
      capture.atLaunch?.fdIdentity !== undefined &&
      capture.afterTeardown.fdIdentity === capture.atLaunch.fdIdentity
    ) {
      violations.push(
        `${PTY_RESIDUAL_CHECK.fdReleased}: the pty master fd is still open on the SAME object ` +
          `(${capture.afterTeardown.fdIdentity}) after teardown — the descriptor leaked`,
      );
    }
  }

  if (violations.length > 0) {
    return {
      verdict: "drift",
      violations,
      reason: `the real pty ran but violated ${violations.length} check(s): ${violations.join("; ")}`,
    };
  }

  // 2. INCONCLUSIVE — nothing drifted, but a required observation is missing. Each gap is a question
  //    this run could not ask; answering it anyway would be the fabricated green the package forbids.
  const gaps: string[] = [];
  if (capture.spawned === undefined) {
    gaps.push(
      `${PTY_RESIDUAL_CHECK.backend}: the real node-pty backend never brought a pty up` +
        (capture.launchFailure !== undefined ? ` (the daemon reported \`${capture.launchFailure}\`)` : ""),
    );
  } else if (capture.spawned.fd === undefined) {
    gaps.push(
      `${PTY_RESIDUAL_CHECK.masterFd}: the real handle exposes no master fd — this is not a POSIX pty ` +
        `(a Windows ConPTY handle has none), so the FD residual cannot be asked here`,
    );
  }
  if (capture.launchStatus === undefined) {
    gaps.push(`${PTY_RESIDUAL_CHECK.launch}: the daemon's launch ingress never answered`);
  }
  if (capture.listedStatus === undefined) {
    gaps.push(`${PTY_RESIDUAL_CHECK.listed}: the launched session was never listed by the daemon`);
  }
  if (capture.atLaunch === undefined) {
    gaps.push(`${PTY_RESIDUAL_CHECK.fdOpened}: the handle was never read while the session was up`);
  }
  if (capture.teardownDriven !== true) {
    gaps.push(`${PTY_RESIDUAL_CHECK.childReaped}: the daemon's teardown was never driven`);
  }
  if (capture.afterTeardown === undefined) {
    gaps.push(`${PTY_RESIDUAL_CHECK.fdReleased}: the handle was never read after teardown`);
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not capture the real pty's handle residual end-to-end: ${gaps.join("; ")}`,
    };
  }

  return {
    verdict: "verified",
    violations: [],
    reason:
      `a session launched through the daemon onto the REAL node-pty backend opened a live pty master fd ` +
      `(${capture.atLaunch?.fdIdentity ?? "?"}) and a live child (pid ${capture.spawned?.pid ?? "?"}), and the ` +
      `daemon's own teardown released the fd (${capture.afterTeardown?.fdErrno ?? "released"}) and REAPED the ` +
      `child (${capture.afterTeardown?.childErrno ?? "gone"}) — no residual`,
  };
}

// --- the drive (impure) ---

/** What {@link drivePtyHandleResidual} needs: a real daemon on the real backend, and its teardown. */
export interface PtyResidualDriveConfig {
  /** The REAL local server, wired with the REAL owned-pty launcher ({@link createObservedPtyLauncher}). */
  readonly server: CcctlServer;
  /** The observing spawner's readout — what the real spawn produced. */
  readonly observed: () => ObservedSpawn | undefined;
  /** The canonical directory the launch is rooted at. */
  readonly cwd: string;
  /**
   * Build the phone's own launch body. INJECTED because `@ccctl/web-ui` is dependency-free plain JS
   * with no type declarations, so its import lives in the (untypechecked) test file rather than in
   * this typechecked source — the placement every web-ui call site in this package uses.
   */
  readonly buildLaunchRequest: (cwd: string) => unknown;
  /** Tear the daemon down — the REAL path whose residual is under test (`server.close()`). */
  readonly teardown: () => Promise<void>;
  /** How long to let the fire-and-forget release converge; defaults to {@link REAP_CONVERGENCE_TIMEOUT_MS}. */
  readonly reapTimeoutMs?: number;
}

/**
 * Drive one real-pty launch end-to-end and self-classify its handle residual.
 *
 * NEVER throws on a divergence or a missing leg — it returns a {@link PtyResidualReport}, so the
 * caller's `switch` is the ONLY place a verdict becomes a pass / fail / skip. That is the package's
 * skips-never-fakes posture: an absent binding is `inconclusive`, a leak is `drift`, and only a
 * complete, disagreeing pair of readings is `verified`.
 */
export async function drivePtyHandleResidual(config: PtyResidualDriveConfig): Promise<PtyResidualReport> {
  const origin = `http://${config.server.address.host}:${config.server.address.port}`;

  // 1. The phone launches — its OWN body, onto the REAL pty backend.
  let launchStatus: number | undefined;
  let launchFailure: string | undefined;
  let sessionId: string | undefined;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config.buildLaunchRequest(config.cwd)),
    });
    launchStatus = res.status;
    const body = (await res.json()) as { sessionId?: string; code?: string; error?: string };
    sessionId = body.sessionId;
    if (res.status !== 201) {
      // The daemon's OWN typed reason (#33) — e.g. `backend-unavailable` when node-pty could not load,
      // `spawn-failed` when it loaded but could not spawn (this repo's default install: the shipped
      // `spawn-helper` is left non-executable by `allowBuilds: node-pty: false`). Carried into the
      // verdict so an `inconclusive` says WHY rather than merely that it could not run.
      launchFailure = body.code ?? body.error;
    }
  } catch (error) {
    launchFailure = `the launch request itself failed: ${(error as Error).message}`;
  }

  const spawned = config.observed();

  // 2. The daemon's own list — the launched session exists (born `registering`, #33/#66).
  let listedStatus: string | undefined;
  if (sessionId !== undefined) {
    try {
      const res = await fetch(`${origin}/api/sessions`);
      const body = (await res.json()) as { sessions?: Array<{ id: string; status: string }> };
      listedStatus = body.sessions?.find((entry) => entry.id === sessionId)?.status;
    } catch {
      // Left undefined — an inconclusive gap, never a guess.
    }
  }

  // 3. Read the OS while the session is UP — the self-guard's live half.
  const fd = spawned?.fd;
  const atLaunch = spawned !== undefined && fd !== undefined ? readHandleState(spawned.pid, fd) : undefined;

  // 4. Drive the REAL teardown, then let it converge (the release is fire-and-forget — see
  //    REAP_CONVERGENCE_TIMEOUT_MS).
  let teardownDriven = false;
  try {
    await config.teardown();
    teardownDriven = true;
  } catch {
    // A teardown that threw never ran to completion — left false, which is an inconclusive gap.
  }

  let afterTeardown: HandleReading | undefined;
  if (teardownDriven && spawned !== undefined && fd !== undefined) {
    afterTeardown = await waitForResidualToSettle(spawned.pid, fd, atLaunch, config.reapTimeoutMs);
  }

  return classifyPtyHandleResidual({
    spawned,
    launchStatus,
    launchFailure,
    sessionId,
    listedStatus,
    atLaunch,
    afterTeardown,
    teardownDriven,
  });
}

/**
 * Re-read the handle until the residual has settled (the child reaped AND the fd no longer the same
 * object) or the deadline passes, then return the LAST reading.
 *
 * Polling is what keeps a race from being reported as a leak: the daemon's release is fire-and-forget,
 * so "gone" is a state the teardown ARRIVES at, not one it has already reached when `close()` resolves.
 * Returning the last reading either way is what keeps a real leak a leak — a genuine residual simply
 * never settles, the deadline passes, and the final reading still shows it, which the classifier reads
 * as `drift`. So the timeout costs time only on a run that is already failing.
 */
async function waitForResidualToSettle(
  pid: number,
  fd: number,
  atLaunch: HandleReading | undefined,
  timeoutMs: number = REAP_CONVERGENCE_TIMEOUT_MS,
): Promise<HandleReading> {
  const deadline = Date.now() + timeoutMs;
  let reading = readHandleState(pid, fd);
  while (!hasSettled(reading, atLaunch) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REAP_POLL_INTERVAL_MS));
    reading = readHandleState(pid, fd);
  }
  return reading;
}

/**
 * Whether a reading shows the residual gone: the child reaped, and the fd either closed or recycled
 * onto a different object.
 *
 * The property that matters is one-directional and is the safety-relevant one: `hasSettled` IMPLIES
 * the classifier would call this reading clean, so the loop can never stop early on a state the
 * verdict would reject — a real leak keeps polling and is still there at the deadline, and is
 * reported. The converse does not quite hold: when the fd is open but `atLaunch.fdIdentity` was never
 * captured, this waits out the full window where the classifier would not have declared an fd leak.
 * That costs only time, and only on a run that is already failing — a missing at-launch identity means
 * the at-launch reading itself violated `fdOpened`, so the verdict is `drift` either way.
 */
function hasSettled(reading: HandleReading, atLaunch: HandleReading | undefined): boolean {
  const fdGone = !reading.fdOpen || (atLaunch?.fdIdentity !== undefined && reading.fdIdentity !== atLaunch.fdIdentity);
  return !reading.childPresent && fdGone;
}
