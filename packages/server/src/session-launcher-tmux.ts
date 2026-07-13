// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **tmux** backend of {@link ISessionLauncher} (#29) — the PRIMARY launcher, because a
 * tmux window is a real, locally-attachable terminal an operator can `tmux attach` from a
 * desk terminal and drive by hand (`SRV-B-003`). That native attachability is exactly the
 * port's defining guarantee (a headful surface, never a hidden server child), so this
 * backend reports {@link TerminalAttachment.attachable} `true` — distinct from the owned-pty
 * fallback (#30), whose attachability is degraded.
 *
 * **What it does.** {@link createTmuxSessionLauncher} returns an {@link ISessionLauncher}
 * whose {@link ISessionLauncher.launch} brings up ONE new tmux **window** running the patched
 * `claude` worker:
 *
 *   1. Ensure a single well-known ccctl tmux **session** exists (`has-session` — and, when
 *      absent, `new-session -d` to create it detached). Each launched surface is a window
 *      inside it, so one `tmux attach -t ccctl` reaches them all.
 *   2. `tmux new-window` the worker rooted at {@link SessionLaunchOptions.cwd}, named after
 *      the {@link SessionLaunchOptions.project} (or a default), CAPTURING the created
 *      window's `session:index` target via `-P -F` — read back rather than guessed, so the
 *      attach hint and the teardown target are exact regardless of window name or index.
 *   3. Return a {@link LaunchedSession}: `attachment` carries the concrete `tmux attach -t
 *      <target>` command (AC2), and `close()` runs `tmux kill-window -t <target>` (idempotent).
 *
 * **Why the worker command is INJECTED, not built here.** The patched `claude` — and the
 * `--sdk-url` control-server wiring that makes the launched session register with the local
 * server and appear in `GET /api/sessions` (AC3) — ships in a SEPARATE repository
 * (`ccctl-patch`, not part of this workspace) and firms up in a later credentialed wave. So
 * this backend takes the worker's argv as a REQUIRED {@link WorkerCommandFactory} seam and
 * asserts NOTHING about the patched-claude CLI: it owns only the tmux orchestration (settled
 * and testable). AC3 is a consequence of launching the caller-supplied, control-server-wired
 * worker in an attachable surface; its end-to-end proof is the fenced e2e live-worker oracle
 * (`live-worker-oracle.ts`), never a faked in-repo worker. This mirrors the e2e launcher seam
 * ({@link https://ccctl | PatchedWorkerLauncher} takes an opaque operator-supplied command)
 * and the CLI `patch` verb (delegates to the external binary verbatim).
 *
 * **Backend absent → reject, don't fake.** When tmux cannot bring a surface up (the `tmux`
 * binary is absent, or a command fails), `launch()` REJECTS — the caller then falls back to
 * another backend (owned-pty #30), exactly as the {@link ISessionLauncher} contract prescribes.
 *
 * The one impure edge (spawning `tmux`) is behind the injectable {@link TmuxRunner} seam, so
 * the whole orchestration is hermetically unit-tested WITHOUT a real tmux — the same
 * seam-behind-a-fake discipline the port's own contract test uses.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "./session-launcher.js";

/** The default tmux binary — a bare name resolved on `PATH`; override for a pinned path. */
export const DEFAULT_TMUX_BIN = "tmux";

/** The default ccctl tmux session every launched window lives in (`tmux attach -t ccctl`). */
export const DEFAULT_TMUX_SESSION_NAME = "ccctl";

/** The window name used when a launch carries no {@link SessionLaunchOptions.project} label. */
export const DEFAULT_WORKER_WINDOW_NAME = "claude";

/**
 * The `-F` format that makes `new-window -P` print the created window's stable target —
 * `session_name:window_index` (e.g. `ccctl:1`). The index is used (not the name) so the
 * captured target is exact even if two windows share a name. This target drives BOTH the
 * operator attach hint and the `kill-window` teardown.
 */
const TMUX_TARGET_FORMAT = "#{session_name}:#{window_index}";

/**
 * The one impure edge: run a `tmux` subcommand and resolve its trimmed stdout, REJECTING on
 * a non-zero exit or a spawn failure (notably `ENOENT` when tmux is absent — the signal the
 * caller falls back to another backend on). Injected so the orchestration is unit-tested
 * against a fake, with no real tmux. Args are the subcommand and its flags (e.g.
 * `["new-window", "-c", cwd, …]`); the binary itself is bound when the runner is built.
 */
export type TmuxRunner = (args: readonly string[]) => Promise<string>;

/**
 * Builds the argv of the patched `claude` worker to exec in the launched window, from one
 * launch's {@link SessionLaunchOptions}. REQUIRED and injected: the patched worker and its
 * control-server wiring ship in `ccctl-patch` (a separate repo, a later credentialed wave),
 * so this backend never bakes that unsettled cross-repo contract in — the caller (the daemon,
 * a later item) supplies it, and the tmux orchestration stays untouched when it firms up.
 */
export type WorkerCommandFactory = (options: SessionLaunchOptions) => readonly string[];

/** Configuration for {@link createTmuxSessionLauncher}. */
export interface TmuxSessionLauncherConfig {
  /**
   * The patched-`claude` worker argv builder (REQUIRED). Its output is exec'd by
   * `tmux new-window` as the window's command. See {@link WorkerCommandFactory} for why this
   * is injected rather than built here.
   */
  readonly workerCommand: WorkerCommandFactory;
  /** The tmux edge; defaults to a real `execFile("tmux", …)` runner (see {@link DEFAULT_TMUX_BIN}). */
  readonly runner?: TmuxRunner;
  /** The ccctl tmux session each launched window lives in; defaults to {@link DEFAULT_TMUX_SESSION_NAME}. */
  readonly sessionName?: string;
  /** The tmux binary the default runner spawns; defaults to {@link DEFAULT_TMUX_BIN}. Ignored when `runner` is set. */
  readonly tmuxBin?: string;
  /** Window name when a launch has no `project`; defaults to {@link DEFAULT_WORKER_WINDOW_NAME}. */
  readonly defaultWindowName?: string;
}

/** The promisified `execFile` — resolves `{ stdout, stderr }`, rejects on non-zero exit / spawn failure. */
const execFileAsync = promisify(execFile);

/**
 * The default {@link TmuxRunner}: spawn `tmuxBin` with the given args and resolve trimmed
 * stdout. `execFile` (no shell) avoids quoting pitfalls and surfaces an absent tmux as an
 * `ENOENT` rejection — which {@link ISessionLauncher.launch} turns into the reject the caller
 * falls back on.
 */
function defaultTmuxRunner(tmuxBin: string): TmuxRunner {
  return async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync(tmuxBin, [...args]);
    return stdout.trim();
  };
}

/**
 * Create the tmux {@link ISessionLauncher} backend (#29) from {@link TmuxSessionLauncherConfig}.
 * Factory-style, matching the codebase's `create…` / `start…` idiom; the returned launcher is
 * stateless beyond its captured config, so one instance serves many concurrent launches (each
 * a distinct window in the shared ccctl session).
 */
export function createTmuxSessionLauncher(config: TmuxSessionLauncherConfig): ISessionLauncher {
  const tmuxBin = config.tmuxBin ?? DEFAULT_TMUX_BIN;
  const sessionName = config.sessionName ?? DEFAULT_TMUX_SESSION_NAME;
  const defaultWindowName = config.defaultWindowName ?? DEFAULT_WORKER_WINDOW_NAME;
  const runner = config.runner ?? defaultTmuxRunner(tmuxBin);
  const buildWorkerCommand = config.workerCommand;

  /** Whether the shared ccctl session is up — `has-session` succeeds when it exists. */
  async function sessionExists(): Promise<boolean> {
    try {
      await runner(["has-session", "-t", sessionName]);
      return true;
    } catch {
      // Non-zero exit (session absent) OR spawn failure (tmux unreachable) — both read as "not up".
      return false;
    }
  }

  /**
   * Ensure the shared ccctl session exists before a window is added to it. Created DETACHED
   * (`new-session -d`, never `-A`: `-A` falls back to an attach that needs a controlling
   * terminal, which a daemon-spawned launch does not have). The check-then-create is not
   * atomic, so a concurrent cold-start launch may win the create between our check and ours:
   * that race is BENIGN — if the session now exists, proceed. Only a create that fails AND
   * leaves no session is genuine tmux-unavailability — re-thrown so `launch()` rejects and the
   * caller falls back to another backend (owned-pty #30).
   */
  async function ensureSession(): Promise<void> {
    if (await sessionExists()) {
      return;
    }
    try {
      await runner(["new-session", "-d", "-s", sessionName]);
    } catch (error) {
      if (!(await sessionExists())) {
        throw error;
      }
      // A concurrent launch created the session first — benign, proceed.
    }
  }

  return {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      const windowName = options.project ?? defaultWindowName;
      const workerArgv = buildWorkerCommand(options);

      await ensureSession();

      // Create the window running the patched worker and read back its exact target. `-P -F`
      // prints `session:index` AFTER the window is created, so the target is precise no matter
      // what index tmux assigned. The worker argv is passed as trailing arguments (exec'd
      // directly by tmux, no shell), rooted at `cwd` via `-c`.
      const target = await runner([
        "new-window",
        "-P",
        "-F",
        TMUX_TARGET_FORMAT,
        "-c",
        options.cwd,
        "-n",
        windowName,
        ...workerArgv,
      ]);

      let closed = false;
      return {
        attachment: {
          attachable: true,
          hint: `${tmuxBin} attach -t ${target}`,
        },
        async close(): Promise<void> {
          if (closed) {
            return;
          }
          closed = true;
          try {
            await runner(["kill-window", "-t", target]);
          } catch {
            // Best-effort, idempotent teardown: the window may already be gone (the operator
            // closed it, or the worker exited on its own), in which case `kill-window` reports
            // "no such window". Swallow it so `close()` is safe to call again and safe on an
            // already-torn-down surface, honoring the port's idempotent-`close` contract.
          }
        },
      };
    },
  };
}
