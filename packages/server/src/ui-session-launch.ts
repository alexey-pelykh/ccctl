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
 * show as prose: a wrong method (405), no launcher configured (501 `launcher-absent`), a
 * malformed body (400 `malformed-request`), a non-prompting permission-mode that could never
 * raise the "awaiting input" signal a remotely-driven UC2 session needs (400
 * `non-prompting-mode`, SRV-C-003 launch half), a working directory that does not exist (400
 * `invalid-cwd`), or a launcher that could bring up no surface at all (502
 * `backend-unavailable` / `worker-not-found` / `spawn-failed`, as the backend classified it).
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
import { UI_SESSIONS_PATH } from "./ui-sessions.js";

/**
 * Hard ceiling on a launch body (1 MiB) — a launch carries only a cwd, a permission mode, and
 * an optional seed prompt, so this is generous while bounding a malformed or hostile
 * `Content-Length`, matching the other control-plane ingresses (`ui-command.ts`).
 */
const MAX_LAUNCH_BODY_BYTES = 1024 * 1024;

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
 */
const LAUNCH_FAILURE_STATUS: Record<LaunchFailureCode, number> = {
  "launcher-absent": 501,
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
 * Launch a session, TRACK its terminal, and place it in the registry as `registering` — the shared
 * core behind both the HTTP ingress and the programmatic {@link CcctlServer.launchSession}, so
 * NEITHER entry point can create a session that nothing will ever reap (a programmatic launch that
 * skipped the pending-launch bookkeeping would leave exactly the ghost #33 exists to prevent).
 *
 * Every refusal is a typed {@link SessionLaunchError}: no launcher configured (`launcher-absent`),
 * a non-prompting permission-mode (`non-prompting-mode` — `acceptEdits` / `bypassPermissions`, a
 * session that could never raise the "awaiting input" signal a remotely-driven UC2 session needs;
 * the sibling attach half, #26, can only MARK such a session degraded, but the launch half CONTROLS
 * the mode, so it enforces prompting), or a working directory that does not exist (`invalid-cwd`).
 * A launcher reject propagates with the code the BACKEND classified it as. The HTTP handler maps
 * each code to its status; a programmatic caller reads `error.code` directly.
 *
 * The guards run BEFORE the launcher, in cheapest-first order, so a refused launch spawns nothing
 * at all and touches no state. On success — and only then — the handle is recorded (so
 * {@link closeLaunchedSessions} tears the terminal down on shutdown) and the `registering` session
 * + its eviction timer are armed ({@link trackPendingLaunch}). Mirrors the {@link injectUserTurn}
 * shared-core seam (one behavior, two entry points).
 *
 * The backend is handed the RESOLVED cwd, never the operator's raw string — see below.
 */
export async function launchSession(state: SessionLaunchState, options: SessionLaunchOptions): Promise<LaunchOutcome> {
  if (state.launcher === undefined) {
    throw new SessionLaunchError("launcher-absent", NO_LAUNCHER_CONFIGURED);
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
  const launched = await state.launcher.launch(resolved);
  // The surface is up. From here the session EXISTS — visible as `registering` until its worker
  // registers (claim) or the timeout reaps it (evict). Both halves live in `pending-launch.ts`.
  const sessionId = randomUUID();
  trackPendingLaunch(state, sessionId, resolved, launched);
  return { sessionId, launched };
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
 * Tear down everything the launch subsystem owns — invoked on shutdown alongside the worker-channel
 * and SSE teardown in `index.ts`. Two halves, in this order:
 *
 *   1. DISARM every pending eviction ({@link clearPendingLaunches}) — a timer left armed past
 *      shutdown would fire against a dead server's state, and would double-close a terminal step 2
 *      is about to close anyway.
 *   2. CLOSE every launched terminal — including the still-`registering` ones, whose surfaces are
 *      just as real as a live session's. Best-effort and fire-and-forget: each
 *      {@link LaunchedSession.close} is idempotent and swallows its own errors (a window the
 *      operator already closed), so a stray reject here must never break `close()`.
 *
 * Clears both collections, so a second shutdown is a no-op.
 */
export function closeLaunchedSessions(state: SessionLaunchState): void {
  clearPendingLaunches(state);
  for (const launched of state.launchedSessions) {
    void launched.close().catch(() => {
      // Swallow: teardown is best-effort; the terminal may already be gone.
    });
  }
  state.launchedSessions.clear();
}
