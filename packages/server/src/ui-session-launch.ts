// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The "New session" ingress — the browser's `fetch` POST that LAUNCHES a fresh headful
 * session (#31, UC2 core; `SRV-B-003`).
 *
 * The browser-facing session namespace (`ui-sessions.ts`, #20) already lists / views / steers
 * EXISTING sessions; this module adds the one that BRINGS ONE INTO BEING: `POST /api/sessions`
 * runs the injected {@link ISessionLauncher} to open a headful, locally-attachable terminal
 * running the patched `claude` (via the primary tmux backend #29 or a fallback #30 — the
 * `session-launcher-fallback.ts` composite the daemon injects).
 *
 * The launched session appears in `GET /api/sessions` FROM BIRTH — from the launch itself, as
 * `registering` (#33): its terminal is up, but its worker has not checked in yet, so it is not
 * viewable or steerable. It becomes a live session when the launched worker registers itself over
 * the environments bridge (§1/§2, `POST /v1/sessions`), whose registration CLAIMS this pending
 * launch and advances the row in place to `connecting`. That registration is the LAUNCHED worker's
 * job (it ships in `ccctl-patch`, a later credentialed wave), proven end-to-end by the fenced
 * live-worker oracle, never by an in-repo fake worker — and if it never comes, the pending launch
 * is EVICTED rather than left behind as a ghost (`pending-launch.ts` owns both halves).
 *
 * So this module owns only the SERVER side of the launch: parse the launch options, run the
 * launcher, TRACK the returned {@link LaunchedSession} handle so the server can tear its
 * terminal down on shutdown, place the launched session in the registry as `registering` until
 * its worker checks in (#33, `pending-launch.ts`), and answer the operator with the minted
 * session id + {@link TerminalAttachment} — which session came up, and how to reach its surface
 * at their own desk. The launcher is INJECTED (a port, backend chosen behind it): the concrete
 * patched-`claude` argv + `--sdk-url` wiring lives in the injected backend, never baked in here.
 *
 * **Fail closed, and say WHY (#33).** Every branch that cannot launch answers a status AND a
 * typed {@link LaunchFailureCode} — never a silent drop, and never an opaque 502 the UI can only
 * show as prose: a wrong method (405), no launcher configured (501 `launcher-absent`), the
 * `maxSessions` cap already full (429 `at-capacity`, #36), a
 * malformed body (400 `malformed-request`), a non-prompting permission-mode that could never
 * raise the "awaiting input" signal a remotely-driven UC2 session needs (400
 * `non-prompting-mode`, SRV-C-003 launch half), a working directory that does not exist (400
 * `invalid-cwd`), or a launcher that could bring up no surface at all (502
 * `backend-unavailable` / `worker-not-found` / `spawn-failed`, as the backend classified it).
 *
 * **Bounded, because a launch is remotely triggerable (#36).** Every `POST /api/sessions` spawns a
 * REAL terminal on the operator's host, and the caller is a phone across a tunnel — so a stuck
 * button or a replaying proxy is a loop that spawns windows until the host dies, taking the
 * operator's own sessions with it. `maxSessions` (default {@link DEFAULT_MAX_SESSIONS}) bounds the
 * live-session count; a launch past it is refused rather than attempted. The cap is enforced in
 * {@link launchSession} — the shared core — so the programmatic entry point is bounded by the same
 * number, and it counts the whole registry, so UC1 attaches occupy slots exactly as UC2 launches do.
 *
 * The cwd is validated HERE, before any backend runs, rather than inferred from a backend's
 * failure: the tmux backend can only surface a bad directory as an opaque non-zero exit plus
 * stderr prose, and this codebase does not classify by parsing prose. A pre-flight
 * ({@link resolveLaunchCwd}) is deterministic, backend-independent, spawns nothing at all (so an
 * invalid cwd cannot even momentarily leave a process behind), and names the operator's mistake
 * precisely. It also RESOLVES the path, and the terminal is rooted at the resolved form — because
 * the launched worker will report its own `getcwd(3)` when it registers, and that is the key its
 * pending launch is matched on (`pending-launch.ts`): launching at the raw string would leave the
 * two sides of that comparison speaking different dialects of the same directory.
 *
 * A launch that FAILS therefore touches no state whatsoever — no session, no pending record, no
 * tracked handle (the AC's "no half-registered ghost session"): the registry is only ever written
 * AFTER a surface actually came up. Browser-facing auth is deferred (see `event-stream.ts`) — the
 * loopback ingress is unauthenticated at this slice.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isNonPromptingPermissionMode, isPermissionMode } from "@ccctl/core";
import { readJsonBody, writeJson } from "./http-response.js";
import {
  clearPendingLaunches,
  resolveLaunchCwd,
  trackPendingLaunch,
  type PendingLaunchState,
} from "./pending-launch.js";
import {
  isSessionLaunchError,
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type LaunchFailureCode,
  type SessionLaunchOptions,
  type TerminalAttachment,
} from "./session-launcher.js";
import { releaseLaunchedSession } from "./session-release.js";
import { UI_SESSIONS_PATH } from "./ui-sessions.js";

/**
 * Hard ceiling on a launch body (1 MiB) — a launch carries only a cwd, a permission mode, and
 * an optional seed prompt, so this is generous while bounding a malformed or hostile
 * `Content-Length`, matching the other control-plane ingresses (`ui-command.ts`).
 */
const MAX_LAUNCH_BODY_BYTES = 1024 * 1024;

/**
 * Default ceiling (8) on how many sessions may be live at once (#36) — the `maxSessions` cap a
 * launch past which is refused `at-capacity`. Overridable per server ({@link ServerConfig.maxSessions});
 * exported so a caller (or a test) can name the default rather than re-hardcode `8`, exactly as
 * {@link DEFAULT_REGISTRATION_TIMEOUT_MS} is.
 *
 * The cap exists because a launch is REMOTELY triggerable and each one spawns a real terminal: a
 * phone-side retry loop (a stuck "New session" button, a flaky tunnel replaying a POST) would
 * otherwise spawn terminals until the host runs out of pty/window/RAM — and the sessions it kills
 * on the way down are the operator's, not the loop's (`SRV-B-003`).
 *
 * 8 is a human number, not a resource-derived one, and choosing it that way is deliberate: the
 * budget being protected is the OPERATOR's (nobody drives 8 concurrent Claude sessions from a
 * phone), and it sits far below any limit the host would actually hit — so the cap bites while the
 * machine is still healthy, which is the only time a refusal is cheap. A host-derived cap (some
 * fraction of RAM or file descriptors) would bind orders of magnitude too late to bound the loop
 * this defends against, and would move under the operator's feet between machines.
 */
export const DEFAULT_MAX_SESSIONS = 8;

/**
 * The "no launcher configured" reason, shared by the HTTP 501 and the programmatic throw so the
 * two entry points describe the one condition identically (single source of truth).
 */
const NO_LAUNCHER_CONFIGURED = "ccctl: no session launcher is configured — this server cannot launch sessions";

/**
 * The "non-prompting mode refused" reason, shared by the HTTP 400 and the programmatic throw so the
 * two entry points describe the one condition identically (single source of truth, mirroring
 * {@link NO_LAUNCHER_CONFIGURED}). Names the two prompting modes so the operator knows how to re-launch.
 */
const NON_PROMPTING_MODE_REFUSED =
  "ccctl: a launched session must run under a prompting permission-mode (`default` or `plan`) so it can block " +
  'on decisions and raise the "awaiting input" signal — `acceptEdits` / `bypassPermissions` never block, so a ' +
  "session launched under them could never ask for you";

/** The "malformed launch body" reason — the shape a launch must take, named so the caller can fix it. */
const MALFORMED_LAUNCH_BODY =
  "ccctl: malformed launch body (expected `{ cwd, permissionMode, project?, initialPrompt? }`)";

/**
 * The "cwd is not a directory" reason (#33). Echoes the offending path — the operator typed it, so
 * naming it back is what makes the error actionable (a typo is visible at a glance).
 */
function invalidCwdReason(cwd: string): string {
  return `ccctl: cannot launch a session at \`${cwd}\` — it is not an existing directory`;
}

/**
 * The "at the session cap" reason (#36). Names the NUMBERS — how many are live, and what the cap is
 * — for the same reason {@link invalidCwdReason} echoes the path: the bare fact is not actionable.
 * "At capacity" alone leaves the operator unable to tell a cap of 2 they forgot they configured from
 * the default 8 they never chose, and both moves it offers (end one, or raise the cap) depend on
 * knowing which.
 *
 * `live` may EXCEED `cap`, so the sentence is phrased to stay true when it does. The cap governs
 * LAUNCHING, which is the only verb this server initiates; a §2 registration is a worker announcing
 * a session that already exists, and refusing it would not un-spawn anything — so an operator who
 * attaches 3 sessions by hand against a cap of 2 is over the cap and nothing is wrong. Reading
 * "3 of 2 slots in use" would say the server had lost count; "3 sessions are live and the cap is 2"
 * is the same two numbers telling the truth.
 */
function atCapacityReason(live: number, cap: number): string {
  const sessions = live === 1 ? "1 session is" : `${live} sessions are`;
  return (
    `ccctl: at capacity — ${sessions} live and the cap is ${cap}, so this server will not launch another. ` +
    "End a session to free a slot, or raise the cap (`maxSessions`)."
  );
}

/**
 * The per-server state the launch ingress reads: the injected launcher (absent → this server
 * cannot launch, a fail-closed 501), the set of launched terminal handles to track for teardown,
 * and — since a launch now places a `registering` session in the registry until its worker checks
 * in (#33) — everything {@link PendingLaunchState} needs to track and evict one. A structural
 * slice of the overall server state, so the handler stays decoupled from the HTTP wiring in
 * `index.ts` (the same shape {@link BridgeState} / {@link WorkerChannelState} take).
 */
export interface SessionLaunchState extends PendingLaunchState {
  /** The injected session launcher, or `undefined` when this server was not configured with one. */
  readonly launcher: ISessionLauncher | undefined;
  /**
   * The ceiling on live sessions (#36) — a launch that would exceed it is refused `at-capacity`.
   * Defaults to {@link DEFAULT_MAX_SESSIONS}; resolved and VALIDATED once at `startServer` (a
   * non-positive-integer cap is refused there, so this is always a usable number) so the whole
   * server reads one number.
   *
   * Counted against `sessions` (inherited from {@link PendingLaunchState}) — exactly the set the AC
   * names, "all live sessions (launched and attached)" — plus {@link SessionLaunchState.launchReservations}.
   * See {@link liveSessionCount}.
   */
  readonly maxSessions: number;
  /**
   * Slots held by launches that are IN FLIGHT (#36) — taken before the launcher is called and released
   * once it settles, so a launch occupies a slot for the whole window in which it has no registry row
   * yet but is already bringing a terminal up.
   *
   * That window is the entire reason this exists. A launch's row is written only AFTER its surface
   * comes up (#33's no-ghost invariant, which this must not weaken — hence a set of its own rather
   * than a placeholder row), and bringing a surface up is slow: tmux shells out, the pty forks. Every
   * concurrent launch in that window would otherwise read the same pre-launch `sessions.size`, pass
   * the cap, and spawn — so the cap would bound a sequential caller and nothing else, which is the
   * opposite of the loop it exists to bound.
   *
   * A `Set` of unique tokens rather than a counter, matching the shape of every other bookkeeping
   * field on this state (`launchedSessions`, `pendingLaunches`): its `size` IS the reading, a token
   * cannot be released twice, and there is no `-= 1` to be forgotten on a path that throws — a leaked
   * decrement would permanently shrink the cap for the life of the process.
   */
  readonly launchReservations: Set<symbol>;
}

/**
 * The `POST /api/sessions` response body — WHICH session came up (its server-minted id) and the
 * launched surface's {@link TerminalAttachment} (whether it is fully attachable, and the
 * operator's concrete attach hint). A browser-facing projection (camelCase, like the
 * `GET /api/sessions` list), NOT the foreign snake_case worker wire.
 *
 * The `sessionId` is the id of the `registering` session the launch just placed in the registry
 * (#33): the launched session appears in `GET /api/sessions` immediately, and this is the handle
 * that addresses that row — so the caller can watch its OWN launch come up (or be evicted) rather
 * than guess which of N rows is theirs. It is the same id the session keeps for life: when the
 * launched worker registers over the bridge (§2), its registration CLAIMS this pending launch and
 * the row advances in place to `connecting` — it is never re-minted.
 */
export interface LaunchAcceptedWire {
  /** The server-minted session id — the `registering` row this launch just created. */
  readonly sessionId: string;
  /** Whether the launched surface is fully attachable (tmux #29) or degraded (owned-pty #30). */
  readonly attachable: boolean;
  /** Human-facing guidance: the concrete attach command, or a note explaining the degradation. */
  readonly hint: string;
}

/** Project a launch outcome to its {@link LaunchAcceptedWire} body. */
function toLaunchAcceptedWire(sessionId: string, attachment: TerminalAttachment): LaunchAcceptedWire {
  return { sessionId, attachable: attachment.attachable, hint: attachment.hint };
}

/**
 * The `POST /api/sessions` FAILURE body (#33) — the human-facing `error` sentence every ccctl
 * fail-closed branch already answers, plus the machine-readable {@link LaunchFailureCode} that
 * says WHICH failure it is. The `error` field keeps the exact shape {@link writeError} produces,
 * so a consumer that only reads `.error` is unaffected; `code` is purely additive, and is what a
 * UI branches on to react precisely (offer a directory picker on `invalid-cwd`, tell the operator
 * to install tmux on `backend-unavailable`) instead of pattern-matching prose.
 */
export interface LaunchFailureWire {
  /** The human-facing, actionable reason — the same `{ error }` shape every other ccctl error answers. */
  readonly error: string;
  /** The machine-readable discriminant a UI switches on. */
  readonly code: LaunchFailureCode;
}

/**
 * The ONE mapping from a {@link LaunchFailureCode} to the HTTP status that carries it — kept in a
 * single exhaustive record (a `Record<LaunchFailureCode, number>`, so a new code cannot be added
 * without `tsc` demanding its status here) rather than scattered across the branches that answer.
 *
 * The split follows who must act: a request the operator can fix is a `4xx` — a body we cannot
 * parse, a mode we refuse, a directory that does not exist; a server that was never wired to
 * launch is `501` (not implemented HERE, which is exactly true); and a host that could bring no
 * surface up is `502` — the launch was well-formed and we could not honor it.
 *
 * `at-capacity` is `429` (#36), and the reasoning is worth pinning because the obvious alternative
 * is `503`. It is a `4xx` by this map's own rule: the launch is REFUSED BY POLICY, not failed by the
 * host — the same shape as `non-prompting-mode` (also a well-formed request this server declines),
 * and the operator is the one who acts (end a session, or raise the cap). A `503` would say the
 * service is unavailable, which is false in the way that matters: the server is healthy, the other
 * 8 sessions are live and steerable, and only this one verb is declining. Within `4xx`, `429` is the
 * member that means "you may not have more of this right now" — its RFC 6585 gloss says "rate
 * limiting" ("too many requests in a given amount of time"), and this is a CONCURRENCY ceiling
 * rather than a rate, but the reading is the established one for a resource cap and it carries the
 * one thing a client must know: retrying the identical request later can succeed. No `Retry-After`
 * accompanies it — a slot frees when a human ends a session, which this server cannot predict, and
 * a guessed delay would be a fabricated promise.
 */
const LAUNCH_FAILURE_STATUS: Record<LaunchFailureCode, number> = {
  "launcher-absent": 501,
  "at-capacity": 429,
  "malformed-request": 400,
  "non-prompting-mode": 400,
  "invalid-cwd": 400,
  "worker-not-found": 502,
  "backend-unavailable": 502,
  "spawn-failed": 502,
};

/** Answer a launch failure: its mapped status, its human `error`, and its machine-readable `code`. */
function writeLaunchFailure(res: ServerResponse, error: SessionLaunchError): void {
  const body: LaunchFailureWire = { error: error.message, code: error.code };
  writeJson(res, LAUNCH_FAILURE_STATUS[error.code], body);
}

/**
 * Normalize ANY throw from the launch path into a typed {@link SessionLaunchError}: a backend that
 * classified its own failure is passed through verbatim, and an unclassified throw (a plain
 * `Error`, or a foreign errno) becomes an honest `spawn-failed` — carrying the original as `cause`,
 * so nothing is swallowed. This is what keeps the wire's `code` a CLOSED set: an error the server
 * cannot name never reaches it under a made-up code.
 */
function toLaunchFailure(error: unknown): SessionLaunchError {
  if (isSessionLaunchError(error)) {
    return error;
  }
  return new SessionLaunchError("spawn-failed", "ccctl: the session terminal could not be spawned", { cause: error });
}

/**
 * Parse and validate a launch body into {@link SessionLaunchOptions}, or `null` when it is not
 * a JSON object carrying a non-empty string `cwd` and a valid {@link PermissionMode}, with
 * optional string `project` / `initialPrompt`. Defensive over arbitrary bytes: a non-object, a
 * missing/blank cwd, an unknown permission mode, or a non-string optional all fail closed. The
 * optionals are OMITTED (not set to `undefined`) when absent — `exactOptionalPropertyTypes`.
 */
function parseLaunchOptions(value: unknown): SessionLaunchOptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { cwd, permissionMode, project, initialPrompt } = value as Record<string, unknown>;
  if (typeof cwd !== "string" || cwd === "") {
    return null;
  }
  if (!isPermissionMode(permissionMode)) {
    return null;
  }
  if (project !== undefined && typeof project !== "string") {
    return null;
  }
  if (initialPrompt !== undefined && typeof initialPrompt !== "string") {
    return null;
  }
  return {
    cwd,
    permissionMode,
    ...(project !== undefined ? { project } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
  };
}

/**
 * What one successful launch yields: WHICH session it brought into being, and the handle to the
 * terminal it is running on. The id is minted at launch (#33) — it keys the `registering` session
 * the launch places in the registry, and it is the id that session keeps for life once its worker's
 * registration claims it.
 */
export interface LaunchOutcome {
  /** The server-minted session id — the `registering` session this launch created. */
  readonly sessionId: string;
  /** The launched terminal's handle ({@link TerminalAttachment} + an idempotent `close`). */
  readonly launched: LaunchedSession;
}

/**
 * How many slots are TAKEN right now — the number the `maxSessions` cap is measured against (#36).
 * Two disjoint halves, because a session occupies a slot from the instant its terminal starts coming
 * up, which is strictly before it has a registry row:
 *
 *   - `sessions` — the registry, which IS the AC's "all live sessions (launched and attached)";
 *   - `launchReservations` — the launches in flight, holding slots they have not yet turned into rows
 *     (see {@link SessionLaunchState.launchReservations}; without this half the cap bounds only a
 *     sequential caller).
 *
 * Disjoint by construction: a launch's reservation is released only after `trackPendingLaunch` has
 * written its row, and with no `await` in between — so a launch is counted exactly once throughout,
 * never twice and never zero times.
 *
 * That the registry half needs no bookkeeping of its own is a property worth stating, because the
 * cheap-looking alternatives are each subtly wrong:
 *
 *   - `launchedSessions` counts only surfaces THIS server launched — a host filled by UC1 attaches
 *     would still launch its 9th terminal;
 *   - `pendingLaunches` counts only the not-yet-registered — it empties as workers check in, so a
 *     loop would be capped only while its sessions were still booting, which is no cap at all.
 *
 * Every write to the registry is one of: a launch placing its `registering` row from birth
 * (`pending-launch.ts`), a §2 registration minting a UC1 attach (`environments-bridge.ts`), a
 * rehydrated survivor of the across-restart reaper (`session-reconcile.ts`), or an in-place status
 * advance (`worker-channel.ts`) that changes no count. Every removal is an END: the ghost-reaper
 * evicting an unregistered launch, or a worker channel driving to `closed`. So the size rises with
 * every session that begins and falls with every session that ends, from either use case — which is
 * exactly the cap's contract, and is why a slot frees with no new plumbing (AC3).
 *
 * Counting `registering` rows is load-bearing, not incidental. They are the whole hazard: a retry
 * loop's terminals are all still `registering` (nothing has had time to check in), so a cap that
 * waited for registration would let the loop spawn every window it wanted before the first one
 * counted. A session's terminal is real from launch, so it occupies a slot from launch.
 */
function liveSessionCount(state: SessionLaunchState): number {
  return state.sessions.size + state.launchReservations.size;
}

/**
 * Launch a session, TRACK its terminal, and place it in the registry as `registering` — the shared
 * core behind both the HTTP ingress and the programmatic {@link CcctlServer.launchSession}, so
 * NEITHER entry point can create a session that nothing will ever reap (a programmatic launch that
 * skipped the pending-launch bookkeeping would leave exactly the ghost #33 exists to prevent).
 *
 * Every refusal is a typed {@link SessionLaunchError}: no launcher configured (`launcher-absent`),
 * every slot under the `maxSessions` cap already held by a live session (`at-capacity`, #36), a
 * non-prompting permission-mode (`non-prompting-mode` — `acceptEdits` / `bypassPermissions`, a
 * session that could never raise the "awaiting input" signal a remotely-driven UC2 session needs;
 * the sibling attach half, #26, can only MARK such a session degraded, but the launch half CONTROLS
 * the mode, so it enforces prompting), or a working directory that does not exist (`invalid-cwd`).
 * A launcher reject propagates with the code the BACKEND classified it as. The HTTP handler maps
 * each code to its status; a programmatic caller reads `error.code` directly.
 *
 * The cap lives HERE, in the shared core, rather than at the HTTP ingress — and that placement is the
 * guarantee, not a tidiness preference. #36 exists to bound a LOOP, and a cap a caller can walk around
 * by picking the other entry point bounds nothing; this is the one seam every launch passes through.
 *
 * The guards run BEFORE the launcher, so a refused launch spawns nothing at all and touches no state.
 * Their ORDER follows the existing `launcher-absent`-first shape: first what makes this server unable
 * to launch ANYTHING right now (no launcher; no free slot) — neither of which the request can fix —
 * then what makes THIS launch illegal (its mode, its cwd). Within that, still cheapest-first: the cap
 * is two in-memory `.size` reads, ahead of the two `realpath`/`stat` syscalls the cwd pre-flight
 * costs. So a loop hammering a full server is refused without touching the filesystem at all.
 *
 * On success — and only then — the handle is recorded (so {@link releaseLaunchedSessions} tears the
 * terminal down on shutdown) and the `registering` session + its eviction timer are armed
 * ({@link trackPendingLaunch}). Mirrors the {@link injectUserTurn} shared-core seam (one behavior,
 * two entry points).
 *
 * The backend is handed the RESOLVED cwd, never the operator's raw string — see below.
 */
export async function launchSession(state: SessionLaunchState, options: SessionLaunchOptions): Promise<LaunchOutcome> {
  if (state.launcher === undefined) {
    throw new SessionLaunchError("launcher-absent", NO_LAUNCHER_CONFIGURED);
  }
  // The cap (#36). `>=` because this launch would be the (live + 1)-th: at the cap there is no slot
  // left to take, so the cap-th session is the last one allowed rather than the first one refused.
  const live = liveSessionCount(state);
  if (live >= state.maxSessions) {
    throw new SessionLaunchError("at-capacity", atCapacityReason(live, state.maxSessions));
  }
  if (isNonPromptingPermissionMode(options.permissionMode)) {
    throw new SessionLaunchError("non-prompting-mode", NON_PROMPTING_MODE_REFUSED);
  }
  // Pre-flight, not post-mortem: a directory that does not exist is the operator's mistake, and
  // naming it here means no backend ever spawns a process that was doomed to fail — so an invalid
  // cwd cannot even momentarily leave a child behind (the "no ghost" AC, at its cheapest). The
  // failure echoes back the RAW path, because that is the one the operator typed and has to fix.
  const cwd = resolveLaunchCwd(options.cwd);
  if (cwd === undefined) {
    throw new SessionLaunchError("invalid-cwd", invalidCwdReason(options.cwd));
  }
  // Launch at the RESOLVED path. The worker inside that terminal will report its own `getcwd(3)` when
  // it registers over §2 — always fully resolved — and that report is matched against the cwd this
  // launch records. Rooting the terminal anywhere but the resolved path means the worker echoes back
  // a string this server never stored, the claim misses, and the eviction timer this launch just
  // armed reaps a session that is very much alive (#33; `pending-launch.ts` § Correlation).
  const resolved: SessionLaunchOptions = { ...options, cwd };
  // TAKE the slot before yielding to the launcher (#36). Everything from the count above to this line
  // is synchronous — no `await` — so on JS's single thread the check and the take are ATOMIC: no
  // second launch can observe the count between them. That is the whole concurrency argument, and it
  // is why this needs no lock; it is also why the reservation must be taken HERE rather than after the
  // launch, and why the cwd pre-flight being synchronous is load-bearing rather than incidental — it
  // sits inside this window, so `resolveLaunchCwd` states the dependency at its own definition too,
  // which is where someone would break it.
  //
  // Without it, `launch()` is a check-then-act race, and the cap is decorative exactly when it matters
  // most: a burst all reads the same pre-launch count, all passes the guard, and all spawns. Not a
  // theoretical interleaving — the spawn is SLOW (tmux shells out; the pty forks), so the window is
  // milliseconds wide, and the caller is a phone across a tunnel whose retry loop is concurrent by
  // nature. Measured on this code before the reservation existed: 40 concurrent POSTs against the
  // default cap of 8 spawned 40 terminals. The tests cover it (a delayed launcher + a `Promise.all`
  // burst) because a zero-delay fake resolves in a microtask and hides the race completely.
  const reservation = Symbol("ccctl.launch-reservation");
  state.launchReservations.add(reservation);
  try {
    const launched = await state.launcher.launch(resolved);
    // The surface is up. From here the session EXISTS — visible as `registering` until its worker
    // registers (claim) or the timeout reaps it (evict). Both halves live in `pending-launch.ts`.
    const sessionId = randomUUID();
    trackPendingLaunch(state, sessionId, resolved, launched);
    return { sessionId, launched };
  } finally {
    // Release in a `finally`, so the slot is handed over on success and given back on failure. The
    // handover is seamless: `trackPendingLaunch` has already written the `registering` row by the time
    // this runs, and no `await` separates the two, so the slot never blinks out of the count — a gap
    // there would let a concurrent launch slip through on a stale reading. On a REJECTED launch it
    // gives the slot back and writes nothing, so a failed launch still touches no session state
    // whatsoever (#33's "no half-registered ghost" invariant, which the reservation must not weaken:
    // it is deliberately NOT the registry, precisely so a failure leaves no row behind).
    state.launchReservations.delete(reservation);
  }
}

/**
 * Handle `POST /api/sessions` — launch a fresh headful session via the injected launcher, track its
 * terminal handle, place it in the registry as `registering`, and answer `201` with its
 * {@link LaunchAcceptedWire} (the minted session id + the surface's attachment).
 *
 * Every failure answers a status AND a typed {@link LaunchFailureWire} `code` (#33): a non-POST
 * method (405 — the one branch with no launch code, since no launch was even attempted), a body
 * that could not be read or parsed (400 `malformed-request`), or any typed refusal / backend
 * failure raised by {@link launchSession} (mapped through {@link LAUNCH_FAILURE_STATUS}).
 *
 * The refusals are NOT pre-checked here — {@link launchSession} owns them, and this handler simply
 * projects whatever it throws. That is the point: the shared core is the single place a launch can
 * be refused, so the HTTP and programmatic entry points cannot drift apart on WHICH launches are
 * legal (a pre-check duplicated here is a second copy of the rule, and a second thing to forget).
 */
export function handleSessionLaunch(req: IncomingMessage, res: ServerResponse, state: SessionLaunchState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeJson(res, 405, { error: `ccctl: ${req.method ?? "?"} not allowed on ${UI_SESSIONS_PATH}` });
    return;
  }
  void readJsonBody(req, MAX_LAUNCH_BODY_BYTES).then(async (result) => {
    if (!result.ok) {
      // An unreadable body (over the cap, or not JSON) — `readJsonBody` already chose the status
      // (413 / 400); carry its reason, and type it as the malformed request it is.
      const body: LaunchFailureWire = { error: result.message, code: "malformed-request" };
      writeJson(res, result.status, body);
      return;
    }
    const options = parseLaunchOptions(result.value);
    if (options === null) {
      writeLaunchFailure(res, new SessionLaunchError("malformed-request", MALFORMED_LAUNCH_BODY));
      return;
    }
    try {
      const { sessionId, launched } = await launchSession(state, options);
      writeJson(res, 201, toLaunchAcceptedWire(sessionId, launched.attachment));
    } catch (error) {
      // Typed by the guard that refused it or the backend that failed; anything unclassifiable
      // becomes an honest `spawn-failed` rather than a guessed code.
      writeLaunchFailure(res, toLaunchFailure(error));
    }
  });
}

/**
 * Release everything the launch subsystem owns — invoked on shutdown alongside the worker-channel
 * and SSE teardown in `index.ts`. Two halves, in this order:
 *
 *   1. DISARM every pending eviction ({@link clearPendingLaunches}) — a timer left armed past
 *      shutdown would fire against a dead server's state, and would double-release a terminal step 2
 *      is about to handle anyway.
 *   2. RELEASE every launched terminal — including the still-`registering` ones, whose surfaces are
 *      just as real as a live session's. Through {@link releaseLaunchedSession} (#35), never
 *      `close()` directly: shutting the daemon down must not kill a session the operator has taken
 *      over at their desk, so each surface is PROBED and only torn down if it is still this server's.
 *      A taken-over surface (and one whose liveness could not be read) is left running — the operator
 *      keeps working, and ccctl simply exits without it.
 *
 * "ccctl simply exits without it" is true of the TMUX backend on its own terms — that window lives in
 * a separate tmux server and never held this process open. For the OWNED-PTY backend it is true only
 * because that backend's `liveness()` is TOTAL: it answers `alive-server-owned` or `exited` and
 * nothing else, so its child is always reaped here. A pty left running would be an un-reaped child on
 * an open fd, and the shape of that dependency is worth knowing before touching either side — it is
 * stated at the pty probe itself (`session-launcher-pty.ts` § `liveness`).
 *
 * Fire-and-forget, exactly as before: {@link releaseLaunchedSession} resolves rather than rejecting
 * (it swallows a `close()` that lost a race to an already-gone window), so a stray reject can never
 * break `close()`. Named `release…` rather than `close…` because that is now what it does — a name
 * that promised an unconditional close would be a lie about the rule this function's whole purpose is
 * to obey.
 *
 * Clears both collections, so a second shutdown is a no-op. The handles are dropped even for the
 * surfaces left running: the server is going away, so it is not going to re-probe them — they are the
 * operator's now, which is the point.
 */
export function releaseLaunchedSessions(state: SessionLaunchState): void {
  clearPendingLaunches(state);
  for (const launched of state.launchedSessions) {
    void releaseLaunchedSession(launched);
  }
  state.launchedSessions.clear();
}
