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
 * **Fenced / opt-in, on its OWN arm — and THIS BLOCK IS THE CANONICAL ACCOUNT OF THE ARMING CHAIN.**
 * It is the single home for *why a default checkout cannot spawn a pty*; every other site in the repo
 * (the package README, the e2e spec's header, `pnpm-workspace.yaml`) POINTS here and restates
 * nothing. That is mechanically enforced, not merely intended: `pty-chain-census.ts` fails the
 * `test` lane when this chain's distinctive tokens appear anywhere else. The enforcement exists
 * because the duplication was the DEFECT GENERATOR — #68 hardened three separate inferred-and-wrong
 * causal claims into copies of this account, and the fix for the third was a prose convention, which
 * is the same class of unenforced intention that produced all three (#235). If you are changing this
 * account, change it HERE and nowhere else.
 *
 * The prerequisite is neither a tailnet (#65/#66/#67) nor an API key (#133) but a real,
 * SPAWN-CAPABLE `node-pty` on this box — so this carries its own arm, `CCCTL_E2E` + `CCCTL_E2E_PTY`
 * ({@link resolvePtyE2EEnv}). That the arm is genuinely separate is not a style choice; it is forced
 * by this repo's own install posture — and a default checkout cannot spawn a pty on EITHER platform,
 * for two DIFFERENT reasons. node-pty resolves its binding `build/Release` → `build/Debug` →
 * `prebuilds/<platform>-<arch>` (`lib/utils.js` § `loadNativeModule`), and its `install` is
 * `node scripts/prebuild.js || node-gyp rebuild`, where `prebuild.js` PROBES for the prebuild
 * directory (present → `exit 0`, absent → `exit 1`; only under `npm_config_build_from_source=true`
 * does it also DELETE `prebuilds/` and exit 1). It never chmods:
 *
 *   1. **Linux** — node-pty ships NO Linux prebuild, so `prebuild.js` exits 1 and `node-gyp rebuild`
 *      is what would produce `build/Release`. `pnpm-workspace.yaml`'s `allowBuilds: node-pty: false`
 *      blocks it, so the binding cannot even LOAD on the `ubuntu-latest` CI runners. This is the arm
 *      `allowBuilds` governs, and the lever a Linux operator flips.
 *      **No `spawn-helper` is BUILT or EXEC'd on Linux, so darwin's mode-644 trap has no Linux
 *      counterpart** — the claim that it does was one of #68's three wrong ones. `binding.gyp:96`
 *      gates the helper target on `OS=="mac"`; `pty.cc` reads `helper_path` unconditionally (:352)
 *      — `unixTerminal.js` passes it on every unix — but USES it only under
 *      `#if defined(__APPLE__)` (:356), so on Linux the string is simply discarded and `forkpty(3)`
 *      (:399) runs instead. (`binding.gyp` also links `-lutil`, which can bite on musl/Alpine.)
 *      **UNVERIFIED end-to-end**: no Linux box was available, so this leg is read off `binding.gyp`,
 *      `pty.cc`, `scripts/prebuild.js`, `package.json` and `lib/utils.js` rather than run.
 *   2. **darwin** — a prebuild IS shipped, so `prebuild.js` exits 0, `node-gyp` NEVER runs (the `||`
 *      short-circuits), and the binding loads fine. But the shipped
 *      `prebuilds/darwin-<arch>/spawn-helper`
 *      is mode `644` — NOT executable — and NO node-pty script ever chmods it (`prebuild.js` probes
 *      and, under `npm_config_build_from_source`, deletes; `post-install.js` touches `build/Release`
 *      + win32's `conpty.dll` only; the package contains no `chmod` at all, which is verifiable
 *      against the pristine tarball rather than a working tree someone may already have armed). So
 *      every spawn fails with `posix_spawnp failed`. Flipping
 *      `allowBuilds` does NOT fix this — it is neither necessary nor sufficient here, since the script
 *      it unblocks exits before `node-gyp` and would not have chmodded anything anyway. The actual
 *      lever is `chmod +x` on that prebuilt helper, and `pnpm install` RE-EXTRACTS it at mode `644`,
 *      so the chmod must be re-applied after every reinstall.
 *      **VERIFIED end-to-end** (#235, darwin-arm64 / node-pty 1.1.0 / Node 26): with the helper at
 *      `644` a real `pty.spawn` throws `posix_spawnp failed.`; `chmod +x` on it and the same spawn
 *      succeeds. Both legs of this were previously read off the node-pty source rather than run —
 *      which is the posture that produced #68's three wrong claims — so THIS darwin half is now the
 *      run one. The Linux half (bullet 1 above) is still not.
 *
 * **Don't hand-apply either lever from memory — run the preflight.** `arm-pty.ts`
 * (`pnpm --filter @ccctl/e2e arm:pty`) PROBES this box: it resolves the real helper, reads its actual
 * mode bit, and prints the lever this platform actually needs. It is the executable half of #235's
 * remedy — a script that reads reality cannot drift the way four hand-synced prose copies did.
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
 *
 * **The worker's lifetime is a DETECTION, not merely a margin (#237).** {@link WORKER_ARGS} derives its
 * sleep from the drive's own tail so the stand-in cannot expire mid-drive — and #237's reviewer proved
 * empirically that the derivation is load-bearing rather than decorative: driving the identical LEAKING
 * daemon and changing ONLY the worker's lifetime flips the verdict, because a stand-in that expires
 * first is reaped by node-pty on its OWN exit, closing the master fd, and the drive then reads a clean
 * `verified` while crediting the daemon with a teardown it never performed. But a derivation only ever
 * buys MARGIN, and margin is not detection: a drive that ran long anyway — the `e2e` lane's
 * `testTimeout` is 120s and the drive's `fetch`es carry no timeout of their own — would reopen the hole
 * silently, because it reopens it as a GREEN. So the elapsed time is now MEASURED rather than merely
 * bounded: every spawn is stamped ({@link ObservedSpawn.spawnedAt}), the after-teardown reading is
 * stamped ({@link PtyResidualCapture.afterTeardownAt}), and a reading that landed at or past the
 * stand-in's OWN lifetime ({@link WORKER_LIFETIME_MS}) is `inconclusive`
 * ({@link PTY_RESIDUAL_CHECK.workerOutlived}) — the run says "I could not attribute this teardown"
 * rather than attributing it to the daemon. That subsumes every CAUSE of a slow drive rather than
 * enumerating them, which is why no `fetch` timeout is needed to close it. The margin stays: it is what
 * makes a healthy run pass. The stamp is what makes an unhealthy one impossible to mistake for one.
 *
 * **The lazy `import("node-pty")` is a load-bearing invariant, and it is GATED (#237).** Everything
 * above rests on {@link defaultPtySpawner} doing its `await import("node-pty")` INSIDE the closure: a
 * refactor hoisting that to module scope would make merely importing `@ccctl/server` load the native
 * binding, and `describe.skipIf` skips a suite's EXECUTION but never its collection-time imports — so
 * the break would land on the credential-free CI lane, at collection, as a module-resolution error
 * naming nothing. This package widened the exposure rather than created it: its barrel
 * (`packages/e2e/src/index.ts`) puts the whole chain in the `test` lane's import graph too, where the
 * fence does not reach. {@link loadedNodePtyModules} + its gate in `pty-handle-residual.test.ts` turn
 * the prose invariant into a test: the binding is a CommonJS module, so loading it — by any route,
 * including the native `.node` addon — populates `require.cache`, and an empty reading there after
 * `@ccctl/server` is loaded is the invariant, asserted rather than hoped for.
 *
 * **Both teardown paths are exercised against the real binding (#237).** The backend signals a child
 * POLITELY first and ESCALATES to an uncatchable `SIGKILL` if it is ignored
 * (`session-launcher-pty.ts` § `close`). {@link WORKER_ARGS}' `sleep` dies on the polite signal, so it
 * drives only the COOPERATIVE half — which left the escalation proven only by #30's unit suite, against
 * a fake whose `kill()` fires a synthetic `onExit`. That is precisely the argument this oracle exists to
 * reject for the polite path, so {@link SIGHUP_IGNORING_WORKER_ARGS} closes it for the other one: the
 * same stand-in, made deaf to the polite signal, so the only thing that can reap it is the escalation.
 * It keeps `exec` — POSIX carries an IGNORED disposition across `exec` (unlike a HANDLED one, which is
 * reset), so `trap '' HUP; exec sleep N` is both deaf AND still the pid node-pty reports, with no shell
 * wrapper standing between the signal and its target and no grandchild to strand. #237 recorded these as
 * mutually exclusive; they are not, which is why the fix is a second argv rather than a redesign.
 *
 * That stand-in has a STARTUP RACE, and it is the sharpest trap in this file: node-pty returns the pid
 * the instant it forks the shell, BEFORE that shell has run its `trap`, so a teardown dispatched
 * milliseconds later — which is what this oracle's drive does — kills an unarmed shell on the POLITE
 * path and reads a perfect `verified` for a run that never reached the escalation. It is closed by
 * WAITING for the arming, observed from the OS ({@link SIGHUP_IGNORING_WORKER_ARMED_COMMAND}), and it
 * was FOUND by {@link createSighupIgnoringPtyLauncher}'s own negative control — which is the whole
 * argument for why every positive here ships one. The control failed on the first armed run, against an
 * oracle whose author believed the stand-in was deaf from birth; without it this file would have shipped
 * a green test that never once escalated.
 */

import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { basename } from "node:path";
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

// --- the lazy-binding gate (pure) ---

/**
 * Which `node-pty` modules a CommonJS require-cache holds — the observation behind the LAZY-IMPORT
 * GATE (#237). Empty is the invariant: `@ccctl/server` must be importable without loading the native
 * binding (see the module doc § "the lazy `import(\"node-pty\")`").
 *
 * **Why `require.cache` is the receiver of record here.** node-pty is CommonJS, and its native `.node`
 * addon is itself loaded through `require` — so EVERY route into the binding, including a dynamic
 * `import()` from ESM and including the addon itself, lands in that cache. It is the OS-equivalent for
 * this claim: an answer from the loader about what it actually loaded, not from the module about what
 * it thinks it did. Pure over the injected keys so the PREDICATE is provable against the real path
 * shapes without loading anything, which is what keeps its gate from passing because the filter is
 * broken rather than because the cache is clean.
 *
 * Matches a `node-pty` PATH SEGMENT rather than the bare substring: under pnpm the store path also
 * carries a `node-pty@1.1.0` segment, and a checkout living under some `…/node-pty-notes/…` directory
 * must not read as a load. Real keys look like `/…/node_modules/node-pty/lib/index.js`.
 */
export function loadedNodePtyModules(cacheKeys: Iterable<string>): string[] {
  return [...cacheKeys].filter((key) => /[\\/]node-pty[\\/]/.test(key));
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

/**
 * The stand-in worker's whole lifetime, in milliseconds — the DEADLINE past which this oracle can no
 * longer tell the daemon's teardown from the child's own exit, and therefore the threshold
 * {@link classifyPtyHandleResidual} refuses to `verified` beyond (see the module doc § "a DETECTION,
 * not merely a margin").
 *
 * Derived from the sleep the worker actually runs rather than written down beside it, for the reason
 * {@link WORKER_ARGS} derives the sleep in the first place: the two must move together, and a
 * hand-synced pair is exactly what fails as a green. Raising {@link REAP_CONVERGENCE_TIMEOUT_MS} now
 * carries the sleep AND this threshold with it.
 *
 * Slightly CONSERVATIVE, and deliberately so: the sleep does not begin until `exec` has replaced the
 * shell, some microseconds after the spawn this is measured from, so the real child outlives this
 * threshold by that much. Erring toward `inconclusive` at the boundary costs a re-run; erring the other
 * way costs a false green, which is the whole thing being guarded against.
 */
export const WORKER_LIFETIME_MS = WORKER_SLEEP_SECONDS * 1_000;

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
 * The coupling the derivation cannot reach is a CALLER passing a
 * {@link PtyResidualDriveConfig.reapTimeoutMs} LARGER than this sleep, which would reopen the hole
 * from outside the module. No caller does — the positive path takes the default and the controls pass a
 * deliberately SMALLER one ({@link LEAK_CONTROL_REAP_TIMEOUT_MS}) — but that is a fact about today's
 * callers, not a guarantee, which is why the derivation is no longer the only thing standing here.
 * {@link WORKER_LIFETIME_MS}'s attribution gate closes it from the other side (#237): it measures the
 * span that actually elapsed, so an over-long window bought from the outside surfaces as an
 * `inconclusive` rather than a green — and so does any OTHER way a drive runs long, which is the point
 * of measuring the outcome instead of enumerating the causes.
 */
export const WORKER_ARGS: readonly string[] = ["-c", `exec sleep ${WORKER_SLEEP_SECONDS}`];

/**
 * The stand-in worker's SIGHUP-IGNORING argv (#237) — {@link WORKER_ARGS}' twin, and the only thing
 * that lets the backend's SIGKILL ESCALATION be asked of the real binding.
 *
 * **The gap it closes.** `close()` signals politely first and escalates to an uncatchable `SIGKILL`
 * only if the child ignored that (`session-launcher-pty.ts` § `close`). A plain `sleep` dies on the
 * polite signal, so every drive this oracle makes with {@link WORKER_ARGS} takes the COOPERATIVE path
 * and the escalation is never reached. That left it proven only by #30's unit suite — which drives a
 * fake whose `kill()` fires a synthetic `onExit`, i.e. it proves the backend BELIEVES it escalated.
 * That is the exact argument this oracle's module doc rejects for the polite path ("a claim about the
 * operating system, and only a real pty can be asked"), so the escalation had the gap the happy path no
 * longer does. A child that really ignores a real signal is the only way to ask.
 *
 * **`trap '' HUP` and `exec` are COMPATIBLE, which is what makes this cheap.** #237 recorded them as
 * mutually exclusive — `exec` being load-bearing, so trapping "requires dropping it" — and that is the
 * one thing here worth stating plainly, because the opposite is true and POSIX says so: `exec` resets
 * HANDLED signals to their default but carries IGNORED ones into the new process image unchanged. So
 * `trap '' HUP` (which sets SIG_IGN, not a handler) survives into `sleep`, and every reason `exec`
 * exists in {@link WORKER_ARGS} survives with it — the pid node-pty reports is still the pid of the
 * process actually running, so the backend's signal reaches its target with no shell in between, and no
 * grandchild is left behind to strand. Dropping `exec` would have cost both. VERIFIED end-to-end
 * (darwin-arm64 / node-pty 1.1.0 / Node 26): the spawned pid reports as `sleep`, survives `SIGHUP`, and
 * dies on `SIGKILL`.
 *
 * The sleep is {@link WORKER_ARGS}' sleep, and must stay so: this worker can only ever be ended by the
 * escalation or by its own expiry, so the same floor that keeps a cooperative child from being reaped by
 * its own exit mid-drive keeps this one from being, too — and the same {@link WORKER_LIFETIME_MS}
 * detection backstops it when the floor is not enough.
 */
export const SIGHUP_IGNORING_WORKER_ARGS: readonly string[] = ["-c", `trap '' HUP; exec sleep ${WORKER_SLEEP_SECONDS}`];

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
  /**
   * WHEN this spawn happened, on {@link ELAPSED_CLOCK} — the instant the stand-in worker's own
   * {@link WORKER_LIFETIME_MS} starts running down, and therefore the origin every later reading's
   * attribution is measured from (#237, module doc § "a DETECTION, not merely a margin").
   *
   * REQUIRED rather than optional, and that is the point: a real spawn always happened at a time, and
   * an optional stamp is one a future edit could quietly stop taking — which would retire the
   * detection silently, as a green. The type is what makes the drive keep measuring.
   */
  readonly spawnedAt: number;
}

/**
 * The clock every elapsed measurement here is taken on: MONOTONIC, so a duration cannot be bent by an
 * NTP step mid-drive — `Date.now()` can go backwards, and a stand-in's expiry is not the kind of claim
 * to settle with a wall clock. Both ends of the span must come off this same clock or the difference is
 * meaningless, which is why it is named once here rather than called twice.
 *
 * `waitForResidualToSettle` deliberately keeps `Date.now()` for its POLLING deadline: a skewed poll
 * loop costs a run some time, whereas a skewed attribution costs a verdict its meaning.
 */
export const ELAPSED_CLOCK: () => number = () => performance.now();

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
  /**
   * EVERY spawn this observer has seen, oldest first — the full record {@link observed} is the tail of.
   *
   * #68 launches exactly once, so its own callers read {@link observed} and the list is a singleton. The
   * list exists for the MULTI-LAUNCH caller (`teardown-timing-residual.ts`, #70), and the reason is a
   * correctness one rather than convenience: with a single slot, a cycle whose launch spawned NOTHING
   * would read the PREVIOUS cycle's pid + fd and probe a handle belonging to a session that is already
   * gone. That stale reading fabricates a verdict in EITHER direction — a residual reported against a
   * cycle that never opened one, or a clean reading credited to a teardown that never ran — so a caller
   * driving more than one launch must be able to ask "did THIS launch produce a new spawn?", which only
   * a growing record can answer.
   */
  readonly spawns: () => readonly ObservedSpawn[];
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
  const spawns: ObservedSpawn[] = [];
  return {
    spawn: async (file, args, options) => {
      const pty = await inner(file, args, options);
      // Stamped HERE — the first instant the child provably exists, and the closest this drive can
      // stand to the moment its lifetime starts running down (#237). Read AFTER the spawn resolves
      // rather than before it is dispatched, so a slow spawn is never charged to the worker's sleep.
      spawns.push({ pid: pty.pid, fd: readMasterFd(pty), spawnedAt: ELAPSED_CLOCK() });
      return pty;
    },
    observed: () => spawns.at(-1),
    spawns: () => spawns,
  };
}

/**
 * The REAL owned-pty launcher, observed — `createPtySessionLauncher` wired to the real
 * {@link defaultPtySpawner} (through {@link createObservingPtySpawner}) and the stand-in worker
 * command. This is the backend the daemon is given; nothing about its orchestration is faked.
 */
export function createObservedPtyLauncher(inner?: PtySpawner): ObservedPtyLauncher {
  return createObservedLauncherRunning(WORKER_ARGS, inner);
}

/** The REAL owned-pty launcher plus the readouts of what its real spawns produced. */
export interface ObservedPtyLauncher {
  readonly launcher: ISessionLauncher;
  readonly observed: () => ObservedSpawn | undefined;
  readonly spawns: () => readonly ObservedSpawn[];
}

/**
 * The REAL owned-pty launcher running `workerArgs`, observed — the shared wiring behind every factory
 * here. The stand-in's argv, the escalation window and an optional readiness wait are the ONLY things
 * any of them vary; the backend itself is `createPtySessionLauncher` against the real
 * {@link defaultPtySpawner} in every case, which is what keeps "nothing about the orchestration is
 * faked" true of all of them rather than only the first.
 *
 * `afterObserved` runs BENEATH the launcher but ABOVE the observer, and that ordering is load-bearing
 * rather than incidental — see the parameter.
 */
function createObservedLauncherRunning(
  workerArgs: readonly string[],
  inner?: PtySpawner,
  killEscalationMs?: number,
  /**
   * An extra wait between the spawn and the launcher receiving its handle — for a stand-in that is not
   * yet what it claims to be at fork time ({@link createSighupIgnoringPtyLauncher}'s arming race).
   *
   * It is layered OUTSIDE {@link createObservingPtySpawner} on purpose: inside, its duration would be
   * charged to nothing, but the spawn's {@link ObservedSpawn.spawnedAt} would be stamped only once it
   * had finished — so the measured span would START LATE and therefore UNDER-report, letting the
   * attribution gate stay silent for exactly that long past the child's real self-expiry. That is the
   * unsafe direction, and the one {@link WORKER_LIFETIME_MS} explicitly errs against. Stamped at the
   * spawn and waited afterwards, the span over-reports by the wait instead, which is the safe way to be
   * wrong.
   */
  afterObserved?: (pty: OwnedPty) => Promise<void>,
): ObservedPtyLauncher {
  const spawner = createObservingPtySpawner(inner);
  const spawn: PtySpawner =
    afterObserved === undefined
      ? spawner.spawn
      : async (file, args, options): Promise<OwnedPty> => {
          const pty = await spawner.spawn(file, args, options);
          await afterObserved(pty);
          return pty;
        };
  return {
    launcher: createPtySessionLauncher({
      workerCommand: () => [WORKER_FILE, ...workerArgs],
      spawn,
      ...(killEscalationMs !== undefined ? { killEscalationMs } : {}),
    }),
    observed: spawner.observed,
    spawns: spawner.spawns,
  };
}

/**
 * SIGKILL every child a launcher spawned, and never throw. The obligation of any factory here that can
 * strand one: a test helper that leaks on purpose must clean up EVERYTHING it leaked, not merely its
 * most recent — #68's own controls launch once, but #70's drives many cycles, and a `reap()` that freed
 * only the newest would leave the rest running on the operator's box.
 *
 * `SIGKILL` rather than a polite signal because both callers strand children that a polite signal
 * cannot end: one by disabling teardown, the other by making the child ignore it
 * ({@link SIGHUP_IGNORING_WORKER_ARGS}). Safe on an already-gone child, which is the outcome it wanted.
 */
function reapAll(spawns: () => readonly ObservedSpawn[]): void {
  for (const { pid } of spawns()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — nothing to reap, which is the outcome this wanted anyway.
    }
  }
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
 * child it stranded ({@link reapAll}).
 */
export function createLeakingPtyLauncher(inner?: PtySpawner): ReapableObservedPtyLauncher {
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
    spawns: real.spawns,
    reap: (): void => {
      reapAll(real.spawns);
    },
  };
}

/** An {@link ObservedPtyLauncher} that can strand a child, and therefore owes the caller a `reap()`. */
export interface ReapableObservedPtyLauncher extends ObservedPtyLauncher {
  /** Kill every child this launcher spawned. The caller's obligation — see {@link reapAll}. */
  readonly reap: () => void;
}

/**
 * The escalation window the SIGHUP-ignoring POSITIVE arms — short, so the escalation lands well inside
 * the drive's own tail ({@link REAP_CONVERGENCE_TIMEOUT_MS}) and the run reaches a verdict promptly.
 *
 * Shortened from the 2s product default via the seam the backend put there for exactly this
 * (`session-launcher-pty.ts` § `PtySessionLauncherConfig.killEscalationMs`: "a test passes a short
 * value to exercise the escalation deterministically"). Not shortened to ~0: the contract under test is
 * *politeness FIRST, escalation after a grace window in which the child was asked nicely and declined*,
 * and a window a cooperative child could not exit inside would test a different, worse contract.
 */
export const ESCALATION_WINDOW_MS = 250;

/**
 * The escalation window the ESCALATION NEGATIVE CONTROL arms — as far out as the stand-in's own expiry,
 * which is to say further than anything in the control's drive can reach ({@link
 * LEAK_CONTROL_REAP_TIMEOUT_MS}). Within that drive the escalation therefore provably CANNOT fire, and
 * a child still present at the end is a child the POLITE signal did not end.
 *
 * Derived from {@link WORKER_LIFETIME_MS} rather than written down, because what it means is "as
 * unreachable as this oracle's clock ever gets": beyond the worker's own lifetime the run has already
 * lost the ability to attribute anything ({@link PTY_RESIDUAL_CHECK.workerOutlived}), so there is
 * nothing further out worth naming. The control reaps in ~1s and never approaches either.
 */
export const ESCALATION_CONTROL_WINDOW_MS = WORKER_LIFETIME_MS;

/**
 * The REAL pty backend running a stand-in that IGNORES the polite signal
 * ({@link SIGHUP_IGNORING_WORKER_ARGS}) — the drive that asks the OS about the backend's SIGKILL
 * ESCALATION (#237). See {@link SIGHUP_IGNORING_WORKER_ARGS} for why the escalation had a gap the
 * cooperative path does not, and why `trap`ping costs `exec` nothing.
 *
 * **The pair, and why the positive needs the control.** Nothing about this launcher observes WHICH
 * signal ended the child — deliberately, because the only thing that could is the backend's own report
 * that it called `kill("SIGKILL")`, and "the backend believes it escalated" is precisely the evidence
 * this oracle exists to refuse. So attribution is bought the way this package always buys it: from the
 * OS, over a PAIR of runs that differ in ONE thing.
 *
 *   - `killEscalationMs` = {@link ESCALATION_WINDOW_MS} (the POSITIVE) → the escalation fires, and the
 *     kernel reports the child reaped and the fd released. `verified`.
 *   - `killEscalationMs` = {@link ESCALATION_CONTROL_WINDOW_MS} (the CONTROL) → the escalation cannot
 *     fire inside the drive, and the kernel reports the child STILL THERE. `drift`.
 *
 * The control is what licenses the positive's attribution, and it is not ceremony: without it a
 * stand-in that quietly stopped ignoring the signal — a `trap` typo, a shell that resets the
 * disposition, a node-pty that grew a process-group kill — would make the positive green via the POLITE
 * path while still being titled after the escalation. That is the same vacuous-positive this package
 * guards everywhere ({@link createLeakingPtyLauncher}, `worker-idle-hold.ts`'s starved control): the
 * control proves the polite signal really does NOT end this child, so in the positive the escalation is
 * the only thing left that can have.
 *
 * `reap()` is the caller's obligation on BOTH: the control strands its child by construction, and a
 * positive that failed may have stranded one too — and this stand-in ignores the polite signal, so
 * SIGKILL is the only thing that can clean up after it ({@link reapAll}).
 */
export function createSighupIgnoringPtyLauncher(
  killEscalationMs: number,
  inner?: PtySpawner,
): SighupIgnoringPtyLauncher {
  let spawnsSeen = 0;
  let allArmed = true;

  // The ARMING WAIT — see SIGHUP_IGNORING_WORKER_ARMED_COMMAND for the race this closes and why the
  // cooperative stand-in needs no such thing. Wired into the LAUNCH rather than into the drive is what
  // keeps it airtight: `launch()` cannot resolve until the child is armed, so every caller — this
  // oracle's teardown included — is ordered after it by construction rather than by remembering to be.
  const real = createObservedLauncherRunning(
    SIGHUP_IGNORING_WORKER_ARGS,
    inner,
    killEscalationMs,
    async (pty): Promise<void> => {
      spawnsSeen += 1;
      if (!(await awaitWorkerArmed(pty.pid))) {
        allArmed = false;
      }
    },
  );
  return {
    ...real,
    reap: (): void => {
      reapAll(real.spawns);
    },
    armed: () => spawnsSeen > 0 && allArmed,
  };
}

/** A {@link ReapableObservedPtyLauncher} whose stand-in must ARM before its verdict means anything. */
export interface SighupIgnoringPtyLauncher extends ReapableObservedPtyLauncher {
  /**
   * Whether EVERY spawn this launcher made was observed to reach its armed state
   * ({@link SIGHUP_IGNORING_WORKER_ARMED_COMMAND}) — and whether there was one at all.
   *
   * `false` is not a defect in the daemon and must never be reported as one: it says the STAND-IN could
   * not be brought to the state that makes the question askable, so the run has no signal either way.
   * The caller skips on it, the way it skips an absent binding.
   */
  readonly armed: () => boolean;
}

/**
 * The command name {@link SIGHUP_IGNORING_WORKER_ARGS} reports once it is ARMED — and the OS-observable
 * proof that it is, which is a sharper thing than it looks.
 *
 * **The startup race this closes, which cost a real false green to find.** node-pty returns the pid the
 * instant it forks `/bin/sh` — BEFORE that shell has read, let alone run, a single word of its `-c`
 * script. So there is a window, at the very start of every launch, in which the child is a shell with
 * the DEFAULT signal disposition and no trap installed. A teardown dispatched inside that window
 * delivers the polite signal to an unarmed shell, which duly dies — and the oracle then reads a child
 * reaped and an fd released and returns `verified`, for a run that never reached the escalation it is
 * named for. The race is not hypothetical and not narrow: this oracle's drive dispatches its teardown
 * within milliseconds of the launch, so it lost the race EVERY time until this wait existed. It was
 * caught by {@link createSighupIgnoringPtyLauncher}'s own negative control, which is the entire reason
 * that control is not ceremony.
 *
 * **Why `exec` makes the arming observable at all.** `trap '' HUP` and `exec sleep N` are ordered: the
 * `exec` cannot have happened unless the `trap` already did. And `exec` REPLACES the process image, so
 * the command the OS reports for that pid changes from a shell to `sleep` at exactly that moment — and
 * never before it. So this name is not a proxy for the arming, it is downstream of it: seeing `sleep`
 * is seeing that the trap is installed. The same `exec` that keeps the pid identity honest also makes
 * the arming legible, which is a second reason not to drop it.
 *
 * Read via `ps` — the OS's own answer, the receiver of record this module uses everywhere, rather than
 * node-pty's `process` getter (its self-report about a handle, which is the class of evidence the module
 * doc rejects on principle).
 *
 * The COOPERATIVE stand-in ({@link WORKER_ARGS}) deliberately has no equivalent, and needs none: it is
 * meant to die on the polite signal, so a signal landing before its `exec` kills the shell instead of
 * the `sleep` — same pid, same reap, same readings, same verdict. The race only bites a stand-in whose
 * whole point is to SURVIVE that signal.
 */
export const SIGHUP_IGNORING_WORKER_ARMED_COMMAND = "sleep";

/** How long the stand-in gets to arm before the run is treated as unaskable. Generous — it takes ~ms. */
export const WORKER_ARMING_TIMEOUT_MS = 5_000;

/** How often the arming probe re-asks the OS. Short: the window it is watching is milliseconds wide. */
const WORKER_ARMING_POLL_INTERVAL_MS = 10;

/**
 * What command the OS says `pid` is running, by BASENAME — or `undefined` when it will not say (the pid
 * is gone, or `ps` is unavailable).
 *
 * The basename is what makes this portable rather than lucky: `ps -o comm=` reports the string the
 * process was executed with, so the shell shows as `/bin/sh` (an absolute path, because that is how this
 * module spawns it) while a `sleep` resolved off `PATH` shows as bare `sleep`. Comparing full strings
 * would make the answer depend on how each half was invoked; comparing basenames asks the question
 * actually being asked.
 */
export function readProcessCommandName(pid: number): string | undefined {
  // Bounded, because this is polled: a `ps` that wedged would otherwise hold the arming loop until the
  // suite's own 120s testTimeout and report the wedge as an oracle failure. A probe that cannot answer
  // promptly has not answered — `undefined` says so, and the arming loop's own deadline decides.
  const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: PROCESS_NAME_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const name = result.stdout.trim();
  return name === "" ? undefined : basename(name);
}

/** How long a single `ps` gets to answer before its reading is treated as absent. */
const PROCESS_NAME_PROBE_TIMEOUT_MS = 2_000;

/**
 * Poll the OS until `pid` reports {@link SIGHUP_IGNORING_WORKER_ARMED_COMMAND} — the stand-in is armed —
 * or the deadline passes. `false` means the question cannot be asked on this box, never that the daemon
 * did anything wrong.
 */
async function awaitWorkerArmed(pid: number, timeoutMs: number = WORKER_ARMING_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readProcessCommandName(pid) === SIGHUP_IGNORING_WORKER_ARMED_COMMAND) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, WORKER_ARMING_POLL_INTERVAL_MS));
  }
}

/**
 * The convergence window a NEGATIVE CONTROL waits. Short on purpose, and the brevity is sound rather
 * than a shortcut: a control has no teardown in flight and nothing to converge to, so its residual is
 * immediate and permanent. Waiting the full {@link REAP_CONVERGENCE_TIMEOUT_MS} would only make the
 * suite slower to reach a verdict it can already read. (The positive paths keep the generous window,
 * where the wait is real.)
 *
 * Named for {@link createLeakingPtyLauncher}, whose control it was first, but it now serves BOTH — the
 * escalation control ({@link createSighupIgnoringPtyLauncher} at {@link ESCALATION_CONTROL_WINDOW_MS})
 * waits it too, and the same one sentence explains both: one strands its child by never signalling it,
 * the other by signalling it something it ignores, and neither has anything converging that a longer
 * wait would catch. Both leak a child ON PURPOSE and both owe a `reap()`, so the LEAK in the name still
 * describes what it is a window for.
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
  workerOutlived: "teardown-attributable (AC2)",
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
  /**
   * WHEN {@link afterTeardown} was read, on the same {@link ELAPSED_CLOCK} as
   * {@link ObservedSpawn.spawnedAt} — the other end of the span that decides whether this run may
   * attribute its clean reading to the daemon at all (#237, module doc § "a DETECTION, not merely a
   * margin").
   *
   * Optional only because {@link afterTeardown} is: they are taken together, and a capture carrying the
   * reading WITHOUT its stamp is itself an inconclusive gap ({@link PTY_RESIDUAL_CHECK.workerOutlived})
   * rather than a run that skips the check. That asymmetry is the point — an unstamped reading must not
   * be a cheaper way to reach `verified` than a stamped one, or the detection is optional in practice
   * however required it looks in the type.
   */
  readonly afterTeardownAt?: number | undefined;
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
  } else {
    // THE ATTRIBUTION GAP (#237). Everything above asks WHAT the readings say; this asks whether this
    // run has earned the right to credit them to the DAEMON. Past the stand-in's own lifetime it has
    // not: the child would have exited on its own, node-pty would have reaped it and closed the master
    // fd on that exit, and the readings a leaking daemon then produces are indistinguishable from a
    // faithful one's. `verified` there is a fabricated green — the reviewer built exactly that run —
    // so the honest verdict is that the question went unasked. See the module doc.
    //
    // A gap rather than a violation, and checked AFTER drift, because it is a limit on what this run
    // could ASK rather than something the daemon DID: a residual actually observed is a residual
    // whenever it was seen, and must not be downgraded to "inconclusive" by a slow drive.
    gaps.push(...attributionGaps(capture));
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
      `child (${capture.afterTeardown?.childErrno ?? "gone"}) — no residual, read ` +
      // The span is carried on the PASS as well as the gap, so a reader can see how much of the
      // stand-in's lifetime the run actually left on the table rather than only that it cleared it
      // (#69's `spannedMultiDay` posture: the verdict never lies about the axis it turned on).
      `${Math.round((capture.afterTeardownAt ?? 0) - (capture.spawned?.spawnedAt ?? 0))}ms into the ` +
      `stand-in's ${WORKER_LIFETIME_MS}ms lifetime, so the teardown is the daemon's and nothing else's`,
  };
}

/**
 * Whether this run may credit its after-teardown reading to the DAEMON — the #237 detection, as the
 * gaps it reports.
 *
 * Two ways to fail it, and the second matters as much as the first: the span may be too long (the
 * stand-in could have expired and reaped itself), or it may be UNMEASURED, which is the same ignorance
 * wearing a cleaner face. An unstamped reading is not evidence that nothing went wrong; it is the
 * absence of the evidence that would say.
 */
function attributionGaps(capture: PtyResidualCapture): string[] {
  const spawnedAt = capture.spawned?.spawnedAt;
  if (spawnedAt === undefined || capture.afterTeardownAt === undefined) {
    return [
      `${PTY_RESIDUAL_CHECK.workerOutlived}: the after-teardown reading carries no timestamp, so it ` +
        `cannot be told from one taken after the stand-in worker's own ${WORKER_LIFETIME_MS}ms lifetime ` +
        `had expired — an unmeasured span is not a short one`,
    ];
  }
  const elapsedMs = Math.round(capture.afterTeardownAt - spawnedAt);
  if (elapsedMs >= WORKER_LIFETIME_MS) {
    return [
      `${PTY_RESIDUAL_CHECK.workerOutlived}: the after-teardown reading landed ${elapsedMs}ms after the ` +
        `spawn, at or past the stand-in worker's own ${WORKER_LIFETIME_MS}ms lifetime — the child could ` +
        `have exited on its OWN and been reaped by node-pty on that exit, closing the master fd, so a ` +
        `LEAKING daemon would read identically here. This teardown is unattributable, not clean`,
    ];
  }
  return [];
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
      // The daemon's OWN typed reason (#33) — e.g. `backend-unavailable` when node-pty could not
      // load, `spawn-failed` when it loaded but could not spawn. Both are the default-checkout
      // outcome, for the two different per-platform reasons this module's header documents — that
      // header is the ONE canonical account; deliberately not restated here, because a restated copy
      // is what drifts. Carried into the verdict so an `inconclusive` says WHY rather than merely
      // that it could not run.
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
  let afterTeardownAt: number | undefined;
  if (teardownDriven && spawned !== undefined && fd !== undefined) {
    afterTeardown = await waitForResidualToSettle(spawned.pid, fd, atLaunch, config.reapTimeoutMs);
    // Stamped WITH the reading, never apart from it: this is the instant the verdict is about, and the
    // whole of what makes that verdict attributable to the daemon rather than to the clock (#237). On a
    // healthy run the settle loop exits the moment the residual is gone, so this lands milliseconds
    // after the spawn; on a leaking one it lands at the convergence deadline, still far short of the
    // stand-in's lifetime — and a run slow enough to reach that lifetime is exactly the one this stamp
    // refuses to let pass as a green.
    afterTeardownAt = ELAPSED_CLOCK();
  }

  return classifyPtyHandleResidual({
    spawned,
    launchStatus,
    launchFailure,
    sessionId,
    listedStatus,
    atLaunch,
    afterTeardown,
    afterTeardownAt,
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
 *
 * Exported for the SECOND residual caller (`teardown-timing-residual.ts`, #70), which reads the same
 * two handles after a different teardown and on a much shorter deadline of its own. What it needs is
 * this SETTLE RULE — "the child reaped, and the fd closed or recycled onto a different object" — and
 * that rule must exist exactly once: a second copy would be free to drift out of agreement with
 * {@link classifyPtyHandleResidual}, and the copy that drifted would be the one deciding when to stop
 * polling. The deadline is already a parameter, which is the only thing the two callers differ on.
 */
export async function waitForResidualToSettle(
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
