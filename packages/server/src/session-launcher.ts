// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `ISessionLauncher` — the portable port for bringing up a Claude Code session on a
 * **real, locally-attachable terminal** (#28).
 *
 * The launcher's defining contract is the SURFACE it produces: a headful terminal an
 * operator can see and sit down at on their own desk — NOT a hidden server child. A ccctl
 * session is meant to be co-driveable (steered from the browser UI *and* attachable at the
 * same terminal), so "launch" here means "open a terminal surface running the patched
 * `claude`", never "spawn a detached background process nobody can reach". That invariant
 * is the whole reason the port exists; it cannot be expressed in the type system, so every
 * backend MUST honor it.
 *
 * The port is BACKEND-AGNOSTIC — callers depend only on this interface, and the concrete
 * backend is chosen behind it. Two backends implement it:
 *
 *   - `tmux new-window` (#29) — the primary: natively attachable (`tmux attach` from a desk
 *     terminal drives the same session), so its {@link TerminalAttachment.attachable} is `true`.
 *   - an owned pty via `node-pty` (#30) — the portable fallback for environments without
 *     tmux; its attachability is DEGRADED, and that degradation is SURFACED to the operator
 *     via {@link TerminalAttachment} rather than silently hidden.
 *
 * iTerm2 stays an optional macOS-only extra, outside this set.
 *
 * Shaped after the launcher port the e2e package already uses (`PatchedWorkerLauncher` in
 * `packages/e2e/src/live-worker-oracle.ts`): an options object in, a handle with `close()`
 * out. Traces to SRV-I-001.
 */

import type { PermissionMode } from "@ccctl/core";

/**
 * The parameters one launch takes. Mirrors the §2 session-create inputs (`SessionContext`
 * / `SessionCreateRequestBody` in `@ccctl/core`) at the local-launch boundary: WHERE to
 * root the session (`cwd`), WHAT to run it under ({@link SessionLaunchOptions.permissionMode}),
 * plus optional starting context (`project`, `initialPrompt`).
 */
export interface SessionLaunchOptions {
  /** Working directory the session (and the patched `claude`) is rooted at. */
  readonly cwd: string;
  /**
   * Permission mode the session runs under — the pinned {@link PermissionMode} set from
   * `@ccctl/core` (`default` / `acceptEdits` / `bypassPermissions` / `plan`), reused so the
   * launcher and the §2 session-create speak one vocabulary.
   */
  readonly permissionMode: PermissionMode;
  /**
   * Optional logical project the session belongs to — a label carried through to the
   * surface (e.g. naming the tmux window), distinct from the filesystem `cwd`. Absent when
   * the launch is not scoped to a named project.
   */
  readonly project?: string;
  /**
   * Optional first prompt to seed the session with. Absent for a bare attachable terminal
   * the operator will drive by hand.
   */
  readonly initialPrompt?: string;
}

/**
 * How an operator reaches the launched terminal at their OWN desk — the reified answer to
 * "is this surface really attachable, and how?". Carrying it on the {@link LaunchedSession}
 * handle (rather than assuming every backend is equal) is what lets the owned-pty fallback
 * (#30) surface its degraded attachability instead of pretending to be a tmux window.
 */
export interface TerminalAttachment {
  /**
   * Whether the surface is fully attachable — `true` for a tmux window an operator can
   * `tmux attach` (#29); `false` for the owned-pty fallback (#30) whose attachability is degraded.
   */
  readonly attachable: boolean;
  /**
   * Human-facing guidance for the operator: the concrete attach command when attachable
   * (e.g. `tmux attach -t ccctl:1`), or a note explaining the degradation when not.
   */
  readonly hint: string;
}

/**
 * A handle to one launched session's terminal surface. Owns that surface's lifecycle:
 * {@link LaunchedSession.attachment} tells the operator how to reach it, and
 * {@link LaunchedSession.close} tears it down (for the owned pty, #30: close the file
 * descriptor and reap the child). Mirrors the e2e `PatchedWorkerHandle`.
 */
export interface LaunchedSession {
  /** How the operator attaches to this surface (and whether they fully can). */
  readonly attachment: TerminalAttachment;
  /**
   * Tear down the launched surface — release its resources and reap any child process.
   * Safe to call more than once (idempotent); resolves once teardown is complete.
   */
  close(): Promise<void>;
}

/**
 * The portable launcher port (#28). Its one method — {@link ISessionLauncher.launch} —
 * brings up a headful, locally-attachable terminal running the patched `claude` under the
 * given {@link SessionLaunchOptions} and returns a {@link LaunchedSession} handle. The
 * concrete backend (tmux #29 / owned-pty #30) sits behind this interface; callers depend
 * only on the port. The `I` prefix marks it a swappable-backend port (traces to
 * SRV-I-001), distinct from the codebase's plain data-shape interfaces.
 */
export interface ISessionLauncher {
  /**
   * Launch a session on a real, locally-attachable terminal. Resolves with the
   * {@link LaunchedSession} once the surface is up; rejects if the backend cannot bring one
   * up (e.g. tmux is absent for the tmux backend — the caller then falls back to another
   * backend).
   */
  launch(options: SessionLaunchOptions): Promise<LaunchedSession>;
}
