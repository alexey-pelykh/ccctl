// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **owned-pty** backend of {@link ISessionLauncher} (#30) — the PORTABLE FALLBACK, for
 * environments where the primary tmux backend (#29) cannot bring a surface up (tmux absent).
 * Where tmux gives a natively-attachable window, this backend OWNS a pseudo-terminal (`node-pty`)
 * running the patched `claude` worker directly. That surface is real and headful, but the
 * operator cannot `tmux attach` to it from a desk terminal, so its attachability is DEGRADED —
 * reported honestly as {@link TerminalAttachment.attachable} `false` (traces to `SRV-B-003`),
 * never dressed up as a tmux window.
 *
 * **What it does.** {@link createPtySessionLauncher} returns an {@link ISessionLauncher} whose
 * {@link ISessionLauncher.launch} spawns the patched worker in an owned pty:
 *
 *   1. Build the worker argv from the launch {@link SessionLaunchOptions} via the injected
 *      {@link WorkerCommandFactory}, and spawn it in a fresh pty rooted at
 *      {@link SessionLaunchOptions.cwd} (AC1).
 *   2. Return a {@link LaunchedSession}: `attachment` reports the DEGRADED, no-direct-attach
 *      surface with an operator-facing note, and `close()` tears the pty down — signalling the
 *      child so the pty file descriptor is released and the child is reaped (AC2).
 *
 * **Why the worker command is INJECTED, not built here.** Identical rationale to the tmux
 * backend: the patched `claude` — and the control-server wiring that makes the launched session
 * register with the local server and appear in `GET /api/sessions` (AC3) — ships in a SEPARATE
 * repository (`ccctl-patch`, a later credentialed wave). So this backend takes the worker's argv
 * as a REQUIRED {@link WorkerCommandFactory} seam and asserts NOTHING about the patched-claude
 * CLI; it owns only the pty orchestration. AC3 is a consequence of launching the caller-supplied,
 * control-server-wired worker in a real pty; its end-to-end proof is the fenced e2e live-worker
 * oracle (`live-worker-oracle.ts`), never a faked in-repo worker.
 *
 * **Backend absent → reject, don't fake.** When the pty cannot be brought up (the spawner throws
 * — e.g. `node-pty`'s native binding is unavailable on this platform, see {@link defaultPtySpawner}),
 * `launch()` REJECTS, so the {@link ISessionLauncher} contract's "the caller then falls back to
 * another backend" holds symmetrically: as the tmux backend rejects onto this one, this one
 * rejects onto whatever follows (or the composite surfaces an {@link AggregateError}).
 *
 * The one impure edge (spawning a pty) is behind the injectable {@link PtySpawner} seam, so the
 * whole orchestration is hermetically unit-tested WITHOUT a real pty (and without loading
 * `node-pty` at all) — the same seam-behind-a-fake discipline the tmux backend and the port's own
 * contract test use. The default spawner LAZILY imports `node-pty` only when it actually runs, so
 * merely importing `@ccctl/server` never loads the native binding.
 */

import {
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "./session-launcher.js";
// The worker-argv seam is shared by every backend (turn one launch's options into the patched
// worker's argv); it is defined once alongside the first backend (tmux, #29) and imported here as
// a TYPE only (erased at runtime — no runtime coupling between the sibling backends).
import type { WorkerCommandFactory } from "./session-launcher-tmux.js";

/** The default terminal type reported to the spawned pty (`TERM`); a widely-supported 256-colour default. */
export const DEFAULT_PTY_TERM_NAME = "xterm-256color";

/** The default pty width (columns) — a conventional 80×24 terminal the worker starts in. */
export const DEFAULT_PTY_COLS = 80;

/** The default pty height (rows) — a conventional 80×24 terminal the worker starts in. */
export const DEFAULT_PTY_ROWS = 24;

/**
 * The default window a child gets to exit on the polite signal before {@link LaunchedSession.close}
 * escalates to {@link FORCED_CHILD_SIGNAL} (2s) — long enough for a cooperating worker to flush and go
 * (a healthy one exits in milliseconds), short enough to stay well inside the emergency-stop's own 5s
 * patience (`session-release.ts` § `STOP_TEARDOWN_TIMEOUT_MS`), which is the deadline that matters: an
 * escalation that landed after the stop had already given up would kill the child while telling the
 * operator it could not. Overridable per launcher ({@link PtySessionLauncherConfig.killEscalationMs})
 * — a test passes a short value to exercise the escalation deterministically.
 */
export const DEFAULT_CHILD_KILL_ESCALATION_MS = 2_000;

/**
 * The signal a child gets when it ignored the polite one — UNCATCHABLE, which is the entire point and
 * the reason it is not merely "a second SIGHUP". A worker that ignored the first signal ignores the
 * tenth; only a signal it cannot handle ends it, and only a child that actually exits fires the
 * `onExit` that reaps it and releases its pty fd.
 */
const FORCED_CHILD_SIGNAL = "SIGKILL";

/**
 * The operator-facing note carried on the DEGRADED {@link TerminalAttachment}. It says plainly
 * that this surface has no direct desk-terminal attach (the owned-pty fallback's whole
 * distinction from a tmux window) and points the operator at the surface they CAN drive it from —
 * the ccctl UI — plus the way to earn a natively-attachable surface next time.
 */
export const DEGRADED_ATTACH_HINT =
  "owned pty (no direct terminal attach — drive this session from the ccctl UI; install tmux for a natively-attachable surface)";

/**
 * The minimal owned-pty surface this backend drives — the subset of `node-pty`'s `IPty` it
 * needs. Declared here (rather than importing `node-pty`'s types) so the backend and its tests
 * carry NO dependency on `node-pty`: the seam is satisfiable by a plain in-memory fake.
 */
export interface OwnedPty {
  /** The spawned child's process id — the reified "there is a real child here" this backend reaps. */
  readonly pid: number;
  /**
   * Register a listener for the child's exit. Fires once, when the child process exits (on its
   * own, or after {@link OwnedPty.kill}); that exit is the signal the pty fd has been released
   * and the child reaped. The event payload is unused by this backend (exit-status-agnostic).
   */
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): void;
  /**
   * Signal the child to terminate. Releasing the owned pty means the child must go: `kill`
   * delivers the signal (default per the pty implementation), the child exits, the pty fd is
   * closed, and {@link OwnedPty.onExit} fires. May throw if the child is already gone.
   */
  kill(signal?: string): void;
}

/** The parameters {@link PtySpawner} is handed for one launch: where to root the pty and its geometry. */
export interface PtySpawnOptions {
  /** Working directory the pty (and the worker in it) is rooted at — {@link SessionLaunchOptions.cwd}. */
  readonly cwd: string;
  /** Terminal type reported to the pty (`TERM`); defaults to {@link DEFAULT_PTY_TERM_NAME}. */
  readonly name: string;
  /** Initial pty width in columns; defaults to {@link DEFAULT_PTY_COLS}. */
  readonly cols: number;
  /** Initial pty height in rows; defaults to {@link DEFAULT_PTY_ROWS}. */
  readonly rows: number;
}

/**
 * The one impure edge: spawn a pty running `file` with `args`, rooted per {@link PtySpawnOptions},
 * resolving an {@link OwnedPty} handle (or throwing / rejecting when no pty can be brought up —
 * the signal {@link ISessionLauncher.launch} turns into the reject the caller falls back on).
 * Injected so the orchestration is unit-tested against a fake, with no real pty and no `node-pty`.
 * May be sync or async (the default is async — it lazily imports `node-pty`).
 */
export type PtySpawner = (
  file: string,
  args: readonly string[],
  options: PtySpawnOptions,
) => OwnedPty | Promise<OwnedPty>;

/** Configuration for {@link createPtySessionLauncher}. */
export interface PtySessionLauncherConfig {
  /**
   * The patched-`claude` worker argv builder (REQUIRED). Its output is spawned in the owned pty.
   * See the module doc for why this is injected rather than built here (same seam the tmux
   * backend uses).
   */
  readonly workerCommand: WorkerCommandFactory;
  /** The pty edge; defaults to {@link defaultPtySpawner} (a real, lazily-loaded `node-pty` spawn). */
  readonly spawn?: PtySpawner;
  /** Terminal type for the spawned pty; defaults to {@link DEFAULT_PTY_TERM_NAME}. */
  readonly termName?: string;
  /** Initial pty width; defaults to {@link DEFAULT_PTY_COLS}. */
  readonly cols?: number;
  /** Initial pty height; defaults to {@link DEFAULT_PTY_ROWS}. */
  readonly rows?: number;
  /**
   * How long a child gets to exit on the polite signal before `close()` escalates to
   * {@link FORCED_CHILD_SIGNAL}; defaults to {@link DEFAULT_CHILD_KILL_ESCALATION_MS}. A test passes a
   * short value to exercise the escalation deterministically.
   */
  readonly killEscalationMs?: number;
}

/**
 * The minimal structural view of `node-pty` the default spawner calls — declared locally so this
 * module has NO compile-time dependency on `node-pty`'s own types (it is an OPTIONAL, lazily
 * loaded native module). `node-pty` is CommonJS, so a dynamic `import()` may surface `spawn` on
 * the namespace or under `default`; both are accommodated in {@link defaultPtySpawner}.
 */
interface NodePtyModule {
  readonly spawn?: NodePtySpawn;
  readonly default?: { readonly spawn: NodePtySpawn };
}

/** `node-pty`'s `spawn` as this backend uses it — structurally typed, not imported from `node-pty`. */
type NodePtySpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly name: string;
    readonly cols: number;
    readonly rows: number;
    readonly env: NodeJS.ProcessEnv;
  },
) => OwnedPty;

/**
 * The default {@link PtySpawner}: lazily import `node-pty` and spawn the worker in a real pty,
 * inheriting `process.env` (so the worker sees `PATH` and the like). The import is dynamic and
 * inside the spawner — NOT a top-level import — so `node-pty`'s native binding loads ONLY when a
 * launch actually reaches this backend, never merely on importing `@ccctl/server`. When `node-pty`
 * cannot load (absent, or its native binding was not built for this platform), this REJECTS with an
 * actionable message, which {@link ISessionLauncher.launch} turns into the reject the caller falls
 * back on.
 *
 * **A default checkout of THIS repo takes that reject on Linux, always** — and the cause is local
 * config, not a missing toolchain: `pnpm-workspace.yaml` does not permit node-pty's build, so no
 * compile runs, the binding is never produced, and there is nothing to load. Why that is, why darwin
 * fails for a DIFFERENT reason, and which lever each platform actually needs live in exactly ONE
 * home: `packages/e2e/src/pty-handle-residual.ts`, module doc § "Fenced / opt-in, on its OWN arm".
 * Not restated here — the duplication is the defect generator (#235), and
 * `packages/e2e/src/pty-chain-census.ts` fails the `test` lane if any other file restates it. To arm
 * a box, don't hand-apply a lever from memory — run the preflight, which probes this box:
 * `pnpm --filter @ccctl/e2e arm:pty`.
 */
export function defaultPtySpawner(): PtySpawner {
  return async (file: string, args: readonly string[], options: PtySpawnOptions): Promise<OwnedPty> => {
    let module: NodePtyModule;
    try {
      module = (await import("node-pty")) as unknown as NodePtyModule;
    } catch (cause) {
      // This backend cannot exist on this host — the honest `backend-unavailable` (#33), the very
      // condition the fallback chain and its typed error were built to report.
      throw new SessionLaunchError(
        "backend-unavailable",
        "ccctl: the owned-pty launcher backend needs the optional 'node-pty' native module, which failed to load " +
          "(absent, or its native binding was not built for this platform). Install/build node-pty, or use the tmux backend.",
        { cause },
      );
    }
    const spawn = module.spawn ?? module.default?.spawn;
    if (spawn === undefined) {
      throw new SessionLaunchError(
        "backend-unavailable",
        "ccctl: the loaded 'node-pty' module exposes no `spawn` — an unexpected node-pty shape",
      );
    }
    return spawn(file, [...args], {
      cwd: options.cwd,
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      env: process.env,
    });
  };
}

/**
 * Classify a pty-spawn failure into its typed {@link SessionLaunchError} (#33). An error that is
 * ALREADY typed (the module-load reject, reached through an injected spawner) passes through
 * unchanged. Otherwise the only structural signal a spawn failure carries is its errno: `ENOENT`
 * says the executable is not at `file` — the patched `claude` was not found, a `worker-not-found`
 * that no fallback backend would fix. Everything else is `spawn-failed`: honest about the fact that
 * this backend could not spawn, and honest about not knowing why.
 */
function toPtyLaunchFailure(cause: unknown, file: string): SessionLaunchError {
  if (cause instanceof SessionLaunchError) {
    return cause;
  }
  if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new SessionLaunchError(
      "worker-not-found",
      `ccctl: the owned-pty backend could not run \`${file}\` — no such executable`,
      { cause },
    );
  }
  return new SessionLaunchError("spawn-failed", "ccctl: the owned-pty backend could not spawn the worker's pty", {
    cause,
  });
}

/**
 * Create the owned-pty {@link ISessionLauncher} backend (#30) from {@link PtySessionLauncherConfig}.
 * Factory-style, matching the codebase's `create…` idiom and the tmux backend; the returned
 * launcher is stateless beyond its captured config, so one instance serves many concurrent
 * launches (each its own independent pty).
 */
export function createPtySessionLauncher(config: PtySessionLauncherConfig): ISessionLauncher {
  const spawn = config.spawn ?? defaultPtySpawner();
  const termName = config.termName ?? DEFAULT_PTY_TERM_NAME;
  const cols = config.cols ?? DEFAULT_PTY_COLS;
  const rows = config.rows ?? DEFAULT_PTY_ROWS;
  const killEscalationMs = config.killEscalationMs ?? DEFAULT_CHILD_KILL_ESCALATION_MS;
  const buildWorkerCommand = config.workerCommand;

  return {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      const workerArgv = buildWorkerCommand(options);
      const [file, ...args] = workerArgv;
      if (file === undefined) {
        // A worker command must name at least the executable; an empty argv could spawn nothing.
        throw new SessionLaunchError(
          "spawn-failed",
          "ccctl: the owned-pty backend needs a non-empty worker command to launch",
        );
      }

      let pty: OwnedPty;
      try {
        pty = await spawn(file, args, { cwd: options.cwd, name: termName, cols, rows });
      } catch (cause) {
        // Classify the spawn failure STRUCTURALLY, never from its prose (#33): an `ENOENT` errno
        // means the executable at `file` is not there — the patched `claude` was not found, which is
        // `worker-not-found` and nothing to do with this backend's availability. Anything else this
        // backend cannot name honestly becomes `spawn-failed` rather than a guess. (A node-pty error
        // that already carries a LaunchFailureCode — the module-load reject above, reached through an
        // injected spawner — passes through untouched.)
        throw toPtyLaunchFailure(cause, file);
      }

      // Track the child's exit so close() can AWAIT the reaping (the "reaps the child" half of AC2)
      // and stay idempotent + safe on an already-exited child. onExit fires once — on the child's
      // own exit, or on the exit our kill() induces.
      let exited = false;
      const exitWaiters: Array<() => void> = [];
      pty.onExit(() => {
        exited = true;
        for (const resolve of exitWaiters.splice(0)) {
          resolve();
        }
      });

      let closed = false;
      return {
        attachment: {
          // The owned pty is a real headful surface but NOT directly attachable from a desk
          // terminal (unlike a tmux window) — surfaced honestly rather than hidden.
          attachable: false,
          hint: DEGRADED_ATTACH_HINT,
        },
        liveness(): Promise<SurfaceLiveness> {
          // An owned pty has exactly TWO liveness readings, and that is a consequence of the
          // degradation this backend already reports rather than a gap in the probe. `taken-over`
          // means the operator reached the surface and took it from the server — and there IS no way
          // to reach this one: it is not attachable ({@link TerminalAttachment.attachable} `false`,
          // {@link DEGRADED_ATTACH_HINT}), so it can only ever be driven through the ccctl UI, which
          // is the server driving it. Nobody can take over a surface they cannot attach to. And
          // NEITHER non-answer applies (#197): this backend OWNS the child and observes its exit
          // directly through {@link OwnedPty.onExit} — there is no host to interrogate, so nothing can
          // be `host-unreachable`, and nothing to interrogate it ABOUT, so nothing can be
          // `surface-indeterminate`. The child's exit is not reported to us, it is observed by us.
          //
          // Read from the SAME `exited` flag `close()` already trusts to decide whether the child
          // still needs signalling, so the probe and the teardown can never disagree about whether
          // this pty is up.
          //
          // **This totality is LOAD-BEARING for shutdown, so do not "improve" it into a non-answer.**
          // Every reading here is one the release rule (`session-release.ts`) either tears down or
          // treats as already-gone — so an owned pty is ALWAYS reaped at shutdown. That is what makes
          // `releaseLaunchedSessions`' "a surface left running is simply left to the operator"
          // (`ui-session-launch.ts`) safe to say: a LEFT-RUNNING pty would be an un-reaped child with
          // an open (never `unref`ed) pty fd, which is a leak the tmux backend cannot have — its
          // window lives in a separate tmux server, ours does not. The trap is that a non-answer is the
          // SAFE answer everywhere else in this rule, so adding a `catch { return "host-unreachable" }`
          // here to "harden" the probe would look like an improvement while quietly stranding a child on
          // every exit — and #197 did not soften that: `RELEASE_BY_LIVENESS` leaves BOTH non-answers
          // running, so neither is a safe thing for this backend to start saying. (`surface-indeterminate`
          // is worse than useless here rather than merely unsafe: it would ALSO be a lie, asserting a
          // host was reached when this backend has no host at all.) If this backend ever gains a reading
          // it cannot make, `unref()` the pty first.
          return Promise.resolve(exited ? "exited" : "alive-server-owned");
        },
        async close(): Promise<void> {
          if (closed) {
            // Idempotent: a second close() is a safe no-op — the child is signalled exactly once.
            return;
          }
          closed = true;
          if (exited) {
            // The child already exited (on its own, or a prior close) — it is reaped and its pty
            // fd released; nothing left to signal.
            return;
          }
          // Register the reaping waiter BEFORE signalling, so a kill that induces an immediate exit
          // cannot resolve before we are listening.
          const reaped = new Promise<void>((resolve) => {
            exitWaiters.push(resolve);
          });
          try {
            // Signal the child: it exits, its pty fd is closed, and onExit fires (AC2). The signal
            // default is the pty implementation's (SIGHUP on POSIX) — enough to end the worker.
            pty.kill();
          } catch {
            // The child may already be gone (kill → ESRCH): its onExit still fires and reaps it, so
            // we fall through to await it rather than treat the throw as a failure.
          }
          // ESCALATE if the polite signal is ignored. Without this, "reaps the child" is a promise this
          // backend keeps only for children that cooperate: SIGHUP is catchable and ignorable, and a
          // worker that ignores it never exits, never fires onExit, and leaves the `await` below
          // pending FOREVER. That is not an exotic child — it is the free-running runaway #76's
          // emergency-stop exists to halt, and it is the one case where every layer above this fails
          // together: the stop gives up (`STOP_TEARDOWN_TIMEOUT_MS`) and reports `stop-failed`, the
          // `closed` latch above then makes every retry a no-op that signals nothing, and shutdown
          // reaps nothing — so the child outlives the daemon with its pty fd, which is exactly the
          // orphan AC2 forbids and the leak {@link liveness} calls out.
          //
          // SIGKILL is uncatchable, so the child exits and onExit fires: the await below settles well
          // inside the stop's own patience, and the abandoned close that latches `closed` over a live
          // child stops being the STANDING outcome for a signal-ignoring worker. It does not become
          // impossible — a child that outlives even SIGKILL (wedged in an uninterruptible syscall) still
          // reaches it — which is exactly why `stopLaunchedSession` re-reads the surface rather than
          // trusting a close that resolved. Politeness first is still the rule: the escalation only
          // fires after a full grace window in which the child was asked nicely and declined. That
          // ordering (term, wait, kill) is what every supervisor does, for this reason.
          const escalation = setTimeout(() => {
            try {
              pty.kill(FORCED_CHILD_SIGNAL);
            } catch {
              // Already gone in the same instant — onExit reaps it and the await settles regardless.
            }
          }, killEscalationMs);
          // `.unref()` so a pending escalation alone never holds the process open — the same posture as
          // this server's other background timers (`pending-launch.ts`, `worker-channel.ts`). It costs
          // nothing here for a reason particular to this backend: the child's own pty fd is never
          // `unref`ed ({@link liveness} spells out why), so for as long as there is a child left to
          // kill, the loop is alive and the escalation gets to fire.
          escalation.unref();
          try {
            // Resolve once the child is actually reaped — teardown is not "done" until it has exited.
            await reaped;
          } finally {
            // The child is gone; a SIGKILL fired at its pid now would be aimed at nothing, or (once the
            // pid is recycled) at somebody else entirely.
            clearTimeout(escalation);
          }
        },
      };
    },
  };
}
