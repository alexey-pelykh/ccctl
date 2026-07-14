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
 *      window's DURABLE `#{window_id}` via `-P -F` — read back rather than guessed, and an id
 *      rather than an index, because tmux RENUMBERS indices and a stale one names a stranger's
 *      window ({@link TMUX_TARGET_FORMAT}).
 *   3. Return a {@link LaunchedSession}: `attachment` carries a concrete attach command that
 *      selects that window by id (AC2), and `close()` runs `tmux kill-window -t @<id>` (idempotent).
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
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
} from "./session-launcher.js";

/** The default tmux binary — a bare name resolved on `PATH`; override for a pinned path. */
export const DEFAULT_TMUX_BIN = "tmux";

/** The default ccctl tmux session every launched window lives in (`tmux attach -t ccctl`). */
export const DEFAULT_TMUX_SESSION_NAME = "ccctl";

/** The window name used when a launch carries no {@link SessionLaunchOptions.project} label. */
export const DEFAULT_WORKER_WINDOW_NAME = "claude";

/**
 * The `-F` format `new-window -P` prints for the created window: its DURABLE id (`@3`) followed by
 * its human `session:index` (`ccctl:1`).
 *
 * The window id is the load-bearing half, and it must be an id rather than an index, because
 * **`session:index` is not a durable handle**. tmux renumbers window indices — `renumber-windows on`
 * is a common `~/.tmux.conf` setting and closing a window re-indexes every window after it, and an
 * operator can reorder windows by hand (`swap-window`, `C-b .`) in the very session this backend
 * advertises as attachable. A captured index therefore names a DIFFERENT window later, and a launcher
 * that keeps one will eventually `kill-window` a stranger. Measured against a real tmux, with
 * `renumber-windows on`: launch A/B/C, evict B's ghost (C renumbers 3→2), launch D (which takes the
 * freed index 3), then evict C by its captured `ccctl:3` — **D, a live registered session, is killed
 * and C's ghost survives**. Both acceptance criteria inverted, in silence, by one stale integer.
 *
 * A `#{window_id}` (`@N`) is unique for the life of the tmux server and is never renumbered, so it
 * still names the same window an hour later. It drives the `kill-window` teardown and the operator's
 * attach hint; the `session:index` is captured alongside it only because it is what a human reads.
 */
const TMUX_TARGET_FORMAT = "#{window_id} #{session_name}:#{window_index}";

/**
 * Escape a value tmux will FORMAT-EXPAND before it uses it — `#` is tmux's format sigil, and `##` is
 * how you say a literal one.
 *
 * `tmux new-window` expands formats in BOTH the `-c` working directory and the `-n` window name, and
 * both carry strings an operator hands us. Measured against a real tmux, with the exact argv this
 * backend builds:
 *
 *   -c '…/proj#Sales'   → the worker comes up in **$HOME**   (`#S` expanded to the session name)
 *   -c '…/proj#{x}'     → the worker comes up in **$HOME**   (`#{…}` is a format)
 *   -c '…/proj##Sales'  → the worker comes up in `…/proj#Sales` ✓
 *
 * In every case `new-window` exits **0** and prints a window target, so nothing upstream can tell that
 * the launch went to the wrong place. Note what is NOT affected: `#` followed by a non-format character
 * (`C#sharp`, `issue#33`) passes through untouched, which is exactly why this survives casual testing —
 * the innocuous spellings are the ones people try.
 *
 * A silently-wrong cwd is the worst failure this backend has, because the launched worker then
 * registers from a directory the server never launched it at: its pending launch is never claimed, and
 * the timer that exists to reap ghosts (#33) instead closes the terminal of a live, registered session
 * ten seconds later. Escaping here is what keeps that timer honest.
 *
 * It also closes a format-injection surface — `#(…)` is tmux's SHELL-COMMAND format, so a directory
 * named after one would otherwise have tmux run it.
 *
 * Applied ONLY to the values tmux expands. The worker argv is exec'd directly and is NOT
 * format-expanded (verified) — escaping it would corrupt a legitimate `#` in an argument — and
 * `TMUX_TARGET_FORMAT` is our own format string, where the `#` is doing exactly the job it is there for.
 */
function tmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##");
}

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

/**
 * Whether the worker binary can actually be EXECUTED on this host — the second impure edge, injected
 * for the same reason {@link TmuxRunner} is (a test must be able to launch a worker that does not
 * exist on the machine running the test).
 *
 * It exists because tmux cannot answer the question. `new-window` execs the command inside the window
 * and reports SUCCESS regardless — exit 0, a printed window target — even when the command is not
 * there; the window just dies. So without this probe the operator is told "launched session <id>",
 * handed an attach hint for a window that is already gone, and watches the row silently vanish ten
 * seconds later when the eviction timer reaps it, with no error ever surfaced. That is precisely the
 * `binary not found` case AC1 (#33) demands a TYPED error for, and a pre-flight is the only way to
 * produce it structurally — the alternative is parsing tmux's stderr prose, which this codebase
 * refuses to do.
 */
export type WorkerBinaryProbe = (command: string, cwd: string) => boolean;

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
  /** The worker-binary edge; defaults to a real `PATH` + `X_OK` probe ({@link defaultWorkerBinaryProbe}). */
  readonly workerBinaryProbe?: WorkerBinaryProbe;
  /** The ccctl tmux session each launched window lives in; defaults to {@link DEFAULT_TMUX_SESSION_NAME}. */
  readonly sessionName?: string;
  /** The tmux binary the default runner spawns; defaults to {@link DEFAULT_TMUX_BIN}. Ignored when `runner` is set. */
  readonly tmuxBin?: string;
  /** Window name when a launch has no `project`; defaults to {@link DEFAULT_WORKER_WINDOW_NAME}. */
  readonly defaultWindowName?: string;
}

/** The "worker binary is not runnable" reason (#33 `worker-not-found`) — names the binary the operator must install or fix. */
function workerNotFoundReason(command: string): string {
  return (
    `ccctl: cannot launch a session — the worker binary \`${command}\` was not found on PATH, or is not ` +
    "executable (run `ccctl patch` to install the patched `claude`)"
  );
}

/**
 * The default {@link WorkerBinaryProbe}: can this host execute `command`, the way the exec inside the
 * launched window will attempt to?
 *
 * "The way the exec will" IS the specification, and each clause of it is a distinct way to get this
 * wrong — a probe that answers a slightly different question is worse than none, because it answers
 * confidently:
 *
 *   - A bare name (`claude`) is walked down `PATH`. The tmux window inherits the CLIENT's environment
 *     (verified against a real tmux, with the server started under a different `PATH`), so this
 *     process's `PATH` really is the one that will be searched. A POSIX-EMPTY `PATH` element means the
 *     current directory — which for the window is `cwd`, not the daemon's.
 *   - A RELATIVE command (`./bin/claude`) resolves against the WINDOW's cwd, the directory the session
 *     is launched in, never against the daemon's. Probing it against the daemon's cwd is wrong in both
 *     directions: a false miss refuses a launch that would have worked, and a false hit opens a window
 *     on a command that is not there — the silent ghost this probe exists to prevent.
 *   - It must be a FILE. Directories carry `+x` (that is how they are traversed), so an `X_OK` check
 *     alone reports a DIRECTORY named `claude` on the `PATH` as perfectly runnable.
 *
 * `X_OK` rather than mere existence: a file that is present but not executable fails to launch just as
 * surely as an absent one. Any error at all reads as "not runnable" — fail closed.
 */
export function defaultWorkerBinaryProbe(command: string, cwd: string): boolean {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes(sep)
      ? [resolve(cwd, command)]
      : (process.env["PATH"] ?? "")
          .split(delimiter)
          .map((dir) => (dir === "" ? resolve(cwd, command) : join(dir, command)));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
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
  const probeWorkerBinary = config.workerBinaryProbe ?? defaultWorkerBinaryProbe;

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

      // Pre-flight the WORKER binary before tmux ever runs, and outside the catch below — this is a
      // launch that cannot succeed, not a tmux that is unavailable, and the two are different answers
      // to the operator (`worker-not-found` vs `backend-unavailable`). It has to happen here because
      // tmux will happily "succeed" at running a command that does not exist (see
      // {@link WorkerBinaryProbe}), and a launch nobody can complete is exactly the ghost #33 exists
      // to prevent — except a silent one, with no error anywhere.
      const workerBin = workerArgv[0];
      if (workerBin === undefined || workerBin === "") {
        throw new SessionLaunchError("spawn-failed", "ccctl: the worker command factory produced an empty argv");
      }
      if (!probeWorkerBinary(workerBin, options.cwd)) {
        throw new SessionLaunchError("worker-not-found", workerNotFoundReason(workerBin));
      }

      // Every TMUX failure this backend can have — the binary absent (ENOENT), a session it could
      // not create, a window it could not open — says exactly ONE thing to the caller: tmux could
      // not bring a surface up here, so fall back (#33 `backend-unavailable`). It deliberately does
      // NOT try to distinguish finer causes: tmux reports them as a non-zero exit plus stderr prose,
      // and classifying by parsing prose is precisely what a typed error exists to avoid. Every cause
      // that IS structurally knowable is caught before this point instead — an invalid cwd at the
      // ingress, and a missing worker binary by the pre-flight just above.
      let windowId: string;
      let indexTarget: string;
      try {
        await ensureSession();

        // Create the window running the patched worker and read back its handle. `-P -F` prints
        // AFTER the window is created, so what comes back is what tmux actually made. The worker argv
        // is passed as trailing arguments (exec'd directly by tmux, no shell), rooted at `cwd` via `-c`.
        //
        // `-c` and `-n` are FORMAT-EXPANDED by tmux and carry operator-supplied strings, so they go
        // through {@link tmuxFormatLiteral} — without it, a tmux format anywhere in the path
        // (`~/src/proj#Sales`) silently lands the worker somewhere else while `new-window` still
        // reports success.
        const captured = await runner([
          "new-window",
          "-P",
          "-F",
          TMUX_TARGET_FORMAT,
          "-c",
          tmuxFormatLiteral(options.cwd),
          "-n",
          tmuxFormatLiteral(windowName),
          ...workerArgv,
        ]);
        [windowId = "", indexTarget = ""] = captured.split(/\s+/);
        if (!windowId.startsWith("@") || indexTarget === "") {
          // Fail closed rather than keep a handle we cannot trust: everything downstream (teardown,
          // the attach hint) is only as good as this handle, and a `kill-window` against a garbage
          // target is how a stranger's window gets killed.
          throw new Error(`ccctl: tmux reported an unreadable window handle for the launch (\`${captured}\`)`);
        }
      } catch (cause) {
        throw new SessionLaunchError(
          "backend-unavailable",
          `ccctl: the tmux backend could not bring up a session window (is \`${tmuxBin}\` installed and working?)`,
          { cause },
        );
      }

      let closed = false;
      return {
        attachment: {
          attachable: true,
          // Both halves address the window by its DURABLE id, never by the index it happened to have
          // at launch: `select-window` first (it works on a detached session, so the operator lands on
          // THEIR window rather than whichever one tmux last had current), then attach. The
          // `session:index` is not used here — it is what a human recognizes, but it goes stale the
          // moment any window before it closes.
          hint: `${tmuxBin} select-window -t ${windowId} \\; attach -t ${sessionName}`,
        },
        async close(): Promise<void> {
          if (closed) {
            return;
          }
          closed = true;
          try {
            await runner(["kill-window", "-t", windowId]);
          } catch {
            // Best-effort, idempotent teardown: the window may already be gone (the operator
            // closed it, or the worker exited on its own), in which case `kill-window` reports
            // "no such window". Swallow it so `close()` is safe to call again and safe on an
            // already-torn-down surface, honoring the port's idempotent-`close` contract. Swallowing
            // is only safe BECAUSE the target is a window id: a stale index would swallow "can't find
            // window" while the real window lived on — or, worse, succeed against a stranger's.
          }
        },
      };
    },
  };
}
