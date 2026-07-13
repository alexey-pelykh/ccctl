// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The production worker-argv builder — the concrete {@link WorkerCommandFactory} the
 * daemon's session launcher (#31) execs to bring up a session worker (#157).
 *
 * `ccctl launch` (UC2) POSTs to a running daemon, which runs its injected
 * {@link https://ccctl | ISessionLauncher}; that launcher execs the argv THIS module
 * builds. Two things it pins, both load-bearing for the launched worker to register
 * against the LOCAL server rather than the real bridge:
 *
 *   - **The binary.** It must be the PATCHED Claude Code binary — re-scoped to the local
 *     server per `ccctl-patch` — not whatever bare `claude` is first on `PATH`. An
 *     unpatched binary would talk to the real bridge, not ccctl. Registration-against-the
 *     -local-server is a property of the PATCHED binary (its baked-in `--sdk-url` control
 *     wiring, which ships in the separate `ccctl-patch` repo), NOT an argv flag — so the
 *     ONLY thing this builder must get right about registration is spawning the *patched*
 *     binary. {@link resolveClaudeBin} binds that path: a sane default ({@link
 *     DEFAULT_CLAUDE_BIN}, a bare `PATH` name) overridable via {@link CLAUDE_BIN_ENV}.
 *
 *   - **The argv.** The worker registers when launched as the `remote-control` SUBCOMMAND
 *     (not a `--remote-control` flag), with an explicit non-interactive spawn mode:
 *     `claude remote-control --name <name> --permission-mode <mode> --spawn=same-dir`.
 *     `--spawn=same-dir` skips the interactive spawn-mode prompt a non-interactive launcher
 *     would otherwise stall on. {@link buildWorkerCommand} emits exactly this form.
 *
 * **Worktree-safe binary resolution.** The default is a BARE `PATH` name ({@link
 * DEFAULT_CLAUDE_BIN}), resolved like the CLI's `ccctl-patch` delegation (`PATCHER_BIN`)
 * and the tmux backend's `tmux` — NEVER a CWD-relative `../` sibling, which would drift
 * when the daemon runs from a git worktree. An operator pins an absolute path via {@link
 * CLAUDE_BIN_ENV} when the patched binary is not on `PATH`.
 */

import type { SessionLaunchOptions, WorkerCommandFactory } from "@ccctl/server";

/**
 * The environment variable binding the patched Claude Code binary the launcher spawns.
 * The "config" side of the issue's "config/flag to bind the patched-binary path": an
 * operator sets it to an absolute path (or an alternate `PATH` name) when the patched
 * binary is not the plain `claude` on `PATH`. Mirrors the {@link
 * https://ccctl | CCCTL_LOCAL_SERVER_AUTH} env-config precedent — kept a named constant so
 * the resolver, the docs, and the tests all reference the one key.
 */
export const CLAUDE_BIN_ENV = "CCCTL_CLAUDE_BIN";

/**
 * The default patched-binary path — a BARE `PATH` name, resolved by the OS the same way
 * the CLI's `ccctl-patch` delegation and the tmux backend's `tmux` are. Deliberately NOT
 * a CWD-relative `../` sibling: the daemon may run from a git worktree, where such a path
 * drifts. An operator overrides it via {@link CLAUDE_BIN_ENV} to pin an absolute path.
 */
export const DEFAULT_CLAUDE_BIN = "claude";

/**
 * The `--name` used when a launch carries no {@link SessionLaunchOptions.project} label —
 * the worker registers under this display name. Mirrors the tmux backend's default window
 * name so an unnamed launch reads consistently across the surface and the registration.
 */
export const DEFAULT_WORKER_NAME = "claude";

/**
 * Resolve the patched-binary path to spawn: the {@link CLAUDE_BIN_ENV} value when
 * configured (trimmed, non-blank), else {@link DEFAULT_CLAUDE_BIN}. A present-but-blank
 * value is treated as "not configured" (an empty path is trivially not a path), matching
 * {@link https://ccctl | requireLocalServerAuth}'s blank-is-absent handling. The `env` is
 * injectable so the resolution is unit-testable without mutating the process environment.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CLAUDE_BIN_ENV]?.trim() ?? "";
  return configured === "" ? DEFAULT_CLAUDE_BIN : configured;
}

/**
 * Build the patched worker's argv for one launch: the `remote-control` subcommand form the
 * worker registers with (#157). `claudeBin` is the resolved patched-binary path (see
 * {@link resolveClaudeBin}); the trailing flags are the issue's pinned shape:
 *
 *   `<claudeBin> remote-control --name <name> --permission-mode <mode> --spawn=same-dir`
 *
 * `--name` is the launch's {@link SessionLaunchOptions.project} label (or {@link
 * DEFAULT_WORKER_NAME} when unset); `--permission-mode` is the pinned {@link
 * https://ccctl | PermissionMode} the launch runs under; `--spawn=same-dir` (one token,
 * as the issue writes it) skips the interactive spawn-mode prompt a non-interactive
 * launcher would stall on. Pure over its inputs so the exact argv is unit-testable.
 */
export function buildWorkerCommand(claudeBin: string, options: SessionLaunchOptions): readonly string[] {
  const name = options.project ?? DEFAULT_WORKER_NAME;
  return [claudeBin, "remote-control", "--name", name, "--permission-mode", options.permissionMode, "--spawn=same-dir"];
}

/**
 * The production {@link WorkerCommandFactory}: resolve the patched-binary path from the
 * environment ({@link resolveClaudeBin}) at launch time — so an operator's {@link
 * CLAUDE_BIN_ENV} override is honored by the long-lived daemon without a rebuild — and
 * build the `remote-control` argv ({@link buildWorkerCommand}). Injected into the tmux
 * launcher via {@link https://ccctl | createTmuxSessionLauncher}'s `workerCommand` seam
 * (see `dependencies.ts`).
 */
export const defaultWorkerCommand: WorkerCommandFactory = (options: SessionLaunchOptions): readonly string[] =>
  buildWorkerCommand(resolveClaudeBin(), options);
