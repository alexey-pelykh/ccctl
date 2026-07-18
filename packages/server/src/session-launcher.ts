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
   * `@ccctl/core`, reused so the launcher and the §2 session-create speak one vocabulary.
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
  /**
   * Optional path to a daemon-owned settings JSON file, passed to the worker as
   * `--settings <path>` (#262, #78 Option A) — a REAL, currently-shipping Claude Code CLI flag
   * ("Path to a settings JSON file … to load additional settings from"), confirmed via
   * `claude --help`. Wires the `AskUserQuestion` `PreToolUse` hook (`hook-settings-installer.ts`)
   * for this ONE launch without touching the operator's own project `.claude/settings.json`.
   * Absent when the caller did not install a hook settings file for this launch (e.g. a test
   * launcher, or a future launch mode that opts out).
   */
  readonly settingsPath?: string;
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
 * What one READING of a launched surface says about it (#35) — the answer the safe-teardown rule
 * (`session-release.ts`) decides by before it may close anything. Five values: three that SAW the
 * surface, and two that did not — because a probe that cannot see must be able to say WHY it cannot.
 *
 *   - `alive-server-owned` — the surface is up and STILL THIS SERVER'S: nobody took it over, so
 *     tearing it down destroys nothing but what we ourselves brought up.
 *   - `taken-over` — the surface is up but the OPERATOR has it: they attached at their own desk and
 *     are driving it by hand. Killing it destroys live human work, which is the one thing teardown
 *     must never do (`SRV-B-003`).
 *   - `exited` — the surface is already gone (the worker exited, the operator closed the window).
 *     Teardown is a no-op: there is nothing left to close and nothing to be sorry about.
 *   - `host-unreachable` — the backend could not reach the HOST that would know: the tmux CLI would
 *     not run, a socket was refused, a probe threw. Nothing was learned about the surface itself.
 *   - `surface-indeterminate` — the backend REACHED the host and the host would not say: a read that
 *     timed out against a live daemon, a probe that raced a reconnect, a backend whose answer was
 *     genuinely inconclusive. The surface may be anything; the channel to it works.
 *
 * Both non-answers are FIRST-CLASS, not failures to paper over: a probe that cannot see the surface
 * must be able to SAY so, because the alternative is guessing, and one of the two guesses kills live
 * work.
 *
 * **Why the non-answer is TWO readings and not one — the distinction is the whole of #197.** Until
 * that issue these were a single `unknown`, and both rules that consume it had to make a
 * defensible-but-lossy call, because the word could not tell them the one thing they each needed:
 * IS THE CHANNEL TO THE SURFACE WORKING? That is not a detail about the reading, it is a fact about
 * what `close()` will do next, and the two rules need opposite halves of it:
 *
 *   - **force** ({@link FORCED_STOP_BY_LIVENESS}) may kill on a reading it cannot resolve ONLY if a
 *     kill would actually travel. Through an unreachable host it would not — it would report
 *     "stopped" having done nothing, which is the one answer an emergency-stop must never give. Down
 *     a working channel it would, so the operator's explicit "kill it" can be honored.
 *   - **the post-close re-read** ({@link stopLaunchedSession}) verifies a `close()` that CLAIMED to
 *     work. A reading taken through an unreachable host is no evidence at all — least of all for a
 *     backend like tmux whose `close()` swallows its own errors — so it must not be read as success.
 *     One taken through a working channel is a backend declining to answer, which genuinely cannot
 *     contradict the close.
 *
 * So the two readings differ in what they license, and a single word licensed the intersection: the
 * cautious answer for both, which was wrong for one of them each time. Splitting them is not a
 * finer taxonomy for its own sake — each half is a premise a rule was already reasoning about and
 * could not observe.
 *
 * **Why this is not the boolean {@link ProcessLivenessProbe} the orphan-reaper (#34) uses.** That
 * probe decides whether to retain or evict a RECORD, and a record has no stake: get it wrong and a
 * row is wrong. This reading decides whether to KILL, so "alive" is not one state but two — alive
 * and ours, alive and theirs — and the difference between them is the entire safety property. A
 * boolean cannot carry it, and neither non-answer has anywhere to live in one at all.
 *
 * **`taken-over` is about SERVER OWNERSHIP, not tmux's attach state.** The word the AC uses for it
 * is "detached", meaning detached from THIS SERVER's ownership — the operator has taken the surface
 * over. It is the opposite of tmux's own "detached session" (which has no client and, for the tmux
 * backend, is precisely the still-ours case). The vocabulary here is ccctl's, deliberately, so the
 * rule reads as what it decides rather than as one backend's jargon.
 *
 * **Which non-answer a backend owes, stated plainly, because getting it backwards inverts a rule.**
 * Report `host-unreachable` when the failure is the CHANNEL — you could not ask. Report
 * `surface-indeterminate` only when you ASKED and got no usable answer back. When in doubt, report
 * `host-unreachable`: it is the conservative half (force will not flip it, and a close verified
 * through it is not believed), so a backend that guesses wrong in that direction costs a refusal the
 * operator can see and retry, while the other direction spends a kill on a channel that may be dead.
 */
export type SurfaceLiveness =
  "alive-server-owned" | "taken-over" | "exited" | "host-unreachable" | "surface-indeterminate";

/** The pinned {@link SurfaceLiveness} set, in one place, for the release rule's decision map and the tests. */
export const SURFACE_LIVENESS_READINGS: readonly SurfaceLiveness[] = [
  "alive-server-owned",
  "taken-over",
  "exited",
  "host-unreachable",
  "surface-indeterminate",
];

/**
 * Runtime guard for {@link SurfaceLiveness} — fails closed on anything outside the pinned set, exactly
 * as {@link isLaunchFailureCode} does for the other closed set that crosses this port. Structural
 * rather than by identity, so a reading that crossed a module boundary is still recognized; but a word
 * this server does not know is NOT one it will act on — the release rule reads it as `host-unreachable`
 * ({@link readLiveness}), the most conservative of the five: do-not-kill even under force, and no
 * evidence that a close worked.
 */
export function isSurfaceLiveness(value: unknown): value is SurfaceLiveness {
  return typeof value === "string" && (SURFACE_LIVENESS_READINGS as readonly string[]).includes(value);
}

/**
 * A handle to one launched session's terminal surface. Owns that surface's lifecycle:
 * {@link LaunchedSession.attachment} tells the operator how to reach it,
 * {@link LaunchedSession.liveness} reports whether it is still up and still ours (#35), and
 * {@link LaunchedSession.close} tears it down (for the owned pty, #30: close the file
 * descriptor and reap the child). Mirrors the e2e `PatchedWorkerHandle`.
 */
export interface LaunchedSession {
  /** How the operator attaches to this surface (and whether they fully can). */
  readonly attachment: TerminalAttachment;
  /**
   * Read this surface's {@link SurfaceLiveness} — is it still up, and is it still THIS SERVER'S
   * (#35)? The oracle every teardown consults before it may close anything
   * ({@link releaseLaunchedSession}); by itself it changes nothing.
   *
   * **On the handle, because only the backend can answer it.** "Is my surface taken over" is not a
   * fact about processes in general — it is a fact about THIS backend's surface, readable only in
   * that backend's own terms (a tmux window's session attach-state; an owned pty's child exit). The
   * backend already holds what it needs to answer, which is also why this needs no durable
   * launch-marker: teardown runs WITHIN the process that launched the surface and still holds this
   * handle, unlike the across-restart orphan-reaper (#34), which has lost its handles and must
   * correlate by a {@link LaunchMarker} instead.
   *
   * **REQUIRED, not optional, and that is a safety choice.** An optional probe has no safe default:
   * absent-reads-as-alive silently kills the operator's session (the bug this exists to fix), and
   * absent-reads-as-a-non-answer silently leaks every surface on every shutdown. So every backend must
   * answer, and `tsc` — not a doc comment — is what holds a backend to it.
   *
   * MAY reject: a probe that throws is read as `host-unreachable` by {@link readLiveness} — the most
   * conservative reading — so a backend never has to invent an answer to avoid throwing. Answering
   * explicitly is preferred where the backend knows it cannot see, and a backend that knows WHICH way
   * it could not see owes the matching reading: `host-unreachable` when it could not ask at all,
   * `surface-indeterminate` when it asked and got nothing usable back ({@link SurfaceLiveness}).
   */
  liveness(): Promise<SurfaceLiveness>;
  /**
   * Tear down the launched surface — release its resources and reap any child process.
   * Safe to call more than once (idempotent); resolves once teardown is complete.
   *
   * The raw MECHANISM, unconditional by design: it closes whatever it is pointed at, asking
   * nothing. The POLICY that decides whether it may be called at all — probe
   * {@link LaunchedSession.liveness} first, and never kill a surface the operator took over — lives
   * in exactly one place, {@link releaseLaunchedSession} (#35). Server teardown paths go through
   * that; a direct `close()` is the unguarded edge and is reserved for the rule itself.
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
   *
   * A reject SHOULD be a {@link SessionLaunchError} carrying the {@link LaunchFailureCode}
   * that says WHY (#33) — the discriminant the ingress projects onto the wire so the UI can
   * tell "that directory does not exist" from "no backend is available" mechanically. A
   * backend classifies only what it knows STRUCTURALLY (an errno, a module that would not
   * load, a runner that rejected); it never guesses from prose, and an unclassifiable failure
   * is honestly `spawn-failed`. A plain `Error` from a backend is tolerated and read as
   * `spawn-failed`.
   */
  launch(options: SessionLaunchOptions): Promise<LaunchedSession>;
}

/**
 * WHY a launch could not bring a session up (#33) — the pinned, machine-readable discriminant
 * a UI switches on, so a failed launch is a TYPED error rather than an opaque 502 + prose.
 * Every launch-failure branch carries exactly one of these, and each maps to one HTTP status at
 * the ingress (`ui-session-launch.ts`).
 *
 * The set partitions the failures by WHO must act:
 *
 *   - the OPERATOR's request is wrong — `invalid-cwd` (the working directory does not exist, or
 *     is not a directory), `non-prompting-mode` (a mode that could never raise the awaiting-input
 *     signal, SRV-C-003), `malformed-request` (an unparseable body);
 *   - this SERVER cannot launch at all — `launcher-absent` (no launcher was wired into it);
 *   - this SERVER will not launch RIGHT NOW — `at-capacity` (#36): every slot under the
 *     `maxSessions` cap is held by a live session, so a further launch is refused until one ends.
 *     Its own branch of the partition because it is the only failure that is neither permanent nor
 *     anybody's mistake: the request is well-formed, the host is healthy, and the same launch
 *     succeeds unchanged the moment a slot frees. That is precisely what the operator must be told
 *     — not "it broke", but "not yet";
 *   - the HOST cannot bring a surface up — `backend-unavailable` (no backend could: tmux is
 *     absent AND the owned-pty fallback could not load), `worker-not-found` (the patched
 *     `claude` binary is not executable at the path the worker argv names);
 *   - anything else — `spawn-failed`, the honest catch-all for a surface that could not be
 *     spawned for a reason the server cannot classify structurally. It is a real answer, not a
 *     dumping ground: a backend that CAN name its failure must, and only an unclassifiable one
 *     lands here.
 *
 * A BACKEND never raises `at-capacity` (nor `launcher-absent` / `malformed-request`): the cap is
 * this server's own policy, counted over state only the server holds, and it is enforced ahead of
 * the port in {@link launchSession}. A backend that has its own ceiling still reports it as
 * whatever it structurally is — a rejected spawn is `spawn-failed`.
 */
export type LaunchFailureCode =
  | "launcher-absent"
  | "at-capacity"
  | "malformed-request"
  | "non-prompting-mode"
  | "invalid-cwd"
  | "worker-not-found"
  | "backend-unavailable"
  | "spawn-failed";

/** The pinned {@link LaunchFailureCode} set, in one place, for the guard, the status map, and the tests. */
export const LAUNCH_FAILURE_CODES: readonly LaunchFailureCode[] = [
  "launcher-absent",
  "at-capacity",
  "malformed-request",
  "non-prompting-mode",
  "invalid-cwd",
  "worker-not-found",
  "backend-unavailable",
  "spawn-failed",
];

/** Runtime guard for {@link LaunchFailureCode} — fails closed on anything outside the pinned set. */
export function isLaunchFailureCode(value: unknown): value is LaunchFailureCode {
  return typeof value === "string" && (LAUNCH_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The typed reject of {@link ISessionLauncher.launch} (and of the ingress's own pre-flight
 * guards) — an `Error` that additionally names its {@link LaunchFailureCode}. The `message`
 * stays the human-facing, actionable sentence the operator reads; the `code` is what a program
 * branches on. Carries the underlying failure as `cause` (never swallowed), so the reason a
 * launch died is still recoverable in a log even though it never reaches the wire.
 */
export class SessionLaunchError extends Error {
  /** The machine-readable reason this launch failed. */
  readonly code: LaunchFailureCode;

  constructor(code: LaunchFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionLaunchError";
    this.code = code;
  }
}

/**
 * Whether `value` is a {@link SessionLaunchError} — the guard the ingress uses to decide between
 * a typed failure (project its `code`) and an unclassified throw (→ `spawn-failed`). Structural
 * rather than `instanceof`, so an error that crossed a module boundary (or a backend that built
 * its own equivalent) is still read as typed — but it fails CLOSED on the code itself
 * ({@link isLaunchFailureCode}), so an errno-bearing throw (`ENOENT` and friends carry a string
 * `code` too) is NOT mistaken for a typed launch failure and can never smuggle a foreign code
 * onto the wire.
 */
export function isSessionLaunchError(value: unknown): value is SessionLaunchError {
  return value instanceof Error && isLaunchFailureCode((value as { code?: unknown }).code);
}
