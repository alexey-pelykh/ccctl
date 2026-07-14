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
 * `session-launcher-fallback.ts` composite the daemon injects). The launched worker then
 * registers itself over the environments bridge (§1/§2, `POST /v1/sessions`) and appears in
 * `GET /api/sessions` from birth, viewable and steerable like any attached session — that
 * registration is the LAUNCHED worker's job (it ships in `ccctl-patch`, a later credentialed
 * wave), proven end-to-end by the fenced live-worker oracle, never by an in-repo fake worker.
 *
 * So this module owns only the SERVER side of the launch: parse the launch options, run the
 * launcher, TRACK the returned {@link LaunchedSession} handle so the server can tear its
 * terminal down on shutdown, and answer the operator with {@link TerminalAttachment} — how to
 * reach the surface at their own desk. The launcher is INJECTED (a port, backend chosen
 * behind it): the concrete patched-`claude` argv + `--sdk-url` wiring lives in the injected
 * backend, never baked in here.
 *
 * Fail-closed on every branch that cannot launch: a wrong method (405), no launcher configured
 * (501), a malformed body (400), a non-prompting permission-mode that could never raise the
 * "awaiting input" signal a remotely-driven UC2 session needs (400, SRV-C-003 launch half), or a
 * launcher that could bring up no surface at all (502) — each answers a status, never a silent
 * drop. Browser-facing auth is deferred (see
 * `event-stream.ts`) — the loopback ingress is unauthenticated at this slice.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isNonPromptingPermissionMode, isPermissionMode } from "@ccctl/core";
import { readJsonBody, writeError, writeJson } from "./http-response.js";
import type {
  ISessionLauncher,
  LaunchedSession,
  SessionLaunchOptions,
  TerminalAttachment,
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

/**
 * The per-server state the launch ingress reads: the injected launcher (absent → this server
 * cannot launch, a fail-closed 501) and the set of launched terminal handles to track for
 * teardown. A structural slice of the overall server state, so the handler stays decoupled
 * from the HTTP wiring in `index.ts` (the same shape {@link BridgeState} / {@link WorkerChannelState} take).
 */
export interface SessionLaunchState {
  /** The injected session launcher, or `undefined` when this server was not configured with one. */
  readonly launcher: ISessionLauncher | undefined;
  /** Handles to the terminals launched by this server, tracked so shutdown can tear them down. */
  readonly launchedSessions: Set<LaunchedSession>;
}

/**
 * The `POST /api/sessions` response body — the launched surface's {@link TerminalAttachment}
 * (whether it is fully attachable, and the operator's concrete attach hint). A browser-facing
 * projection (camelCase, like the `GET /api/sessions` list), NOT the foreign snake_case worker
 * wire. It carries NO session id: the id is minted later, when the launched worker registers
 * over the bridge (§2) — the launch confirms a terminal came up and how to reach it, and the
 * session then appears in the list on its own.
 */
export interface LaunchAcceptedWire {
  /** Whether the launched surface is fully attachable (tmux #29) or degraded (owned-pty #30). */
  readonly attachable: boolean;
  /** Human-facing guidance: the concrete attach command, or a note explaining the degradation. */
  readonly hint: string;
}

/** Project a launched session's {@link TerminalAttachment} to its {@link LaunchAcceptedWire} body. */
function toLaunchAcceptedWire(attachment: TerminalAttachment): LaunchAcceptedWire {
  return { attachable: attachment.attachable, hint: attachment.hint };
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
 * Launch a session and TRACK its handle — the shared core behind both the HTTP ingress and the
 * programmatic {@link CcctlServer.launchSession}. Throws when no launcher is configured (the
 * HTTP handler pre-checks this to answer a 501; the programmatic caller gets the throw), throws
 * when the launch requests a non-prompting permission-mode (`acceptEdits` / `bypassPermissions` —
 * a session that could never raise the "awaiting input" signal a remotely-driven UC2 session needs;
 * the HTTP handler pre-checks this too, to answer a 400), and propagates a launcher reject (every
 * backend failed). On success the handle is recorded so {@link closeLaunchedSessions} can tear the
 * terminal down on shutdown. Mirrors the {@link injectUserTurn} shared-core seam (one behavior, two
 * entry points).
 */
export async function launchSession(
  state: SessionLaunchState,
  options: SessionLaunchOptions,
): Promise<LaunchedSession> {
  if (state.launcher === undefined) {
    throw new Error(NO_LAUNCHER_CONFIGURED);
  }
  // The launch half of the prompting-mode requirement (SRV-C-003): a UC2 launch is remotely driven —
  // the operator is not sitting at the terminal — so under a non-prompting mode the worker would never
  // block on a decision and could never raise the "awaiting input" signal. Refuse it rather than birth a
  // session that can never ask for you (the sibling attach half, #26, can only MARK such a session
  // degraded; the launch half CONTROLS the mode, so it enforces prompting). The HTTP handler pre-checks
  // this to answer a 400; this throw guards the programmatic caller too.
  if (isNonPromptingPermissionMode(options.permissionMode)) {
    throw new Error(NON_PROMPTING_MODE_REFUSED);
  }
  const launched = await state.launcher.launch(options);
  state.launchedSessions.add(launched);
  return launched;
}

/**
 * Handle `POST /api/sessions` — launch a fresh headful session via the injected launcher, track
 * its terminal handle, and answer `201` with the surface's {@link LaunchAcceptedWire}. Reads the
 * body under a size cap and validates it; fails closed on a non-POST method (405), no configured
 * launcher (501), a malformed body (400), a non-prompting permission-mode (400, SRV-C-003 launch
 * half), or a launcher that could bring up no surface (502).
 */
export function handleSessionLaunch(req: IncomingMessage, res: ServerResponse, state: SessionLaunchState): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeError(res, 405, `ccctl: ${req.method ?? "?"} not allowed on ${UI_SESSIONS_PATH}`);
    return;
  }
  // No launcher wired (this slice, or a server that does not launch): fail closed rather than
  // read a body we cannot act on. The daemon injects one in the credentialed wave.
  if (state.launcher === undefined) {
    writeError(res, 501, NO_LAUNCHER_CONFIGURED);
    return;
  }
  void readJsonBody(req, MAX_LAUNCH_BODY_BYTES).then(async (result) => {
    if (!result.ok) {
      writeError(res, result.status, result.message);
      return;
    }
    const options = parseLaunchOptions(result.value);
    if (options === null) {
      writeError(
        res,
        400,
        "ccctl: malformed launch body (expected `{ cwd, permissionMode, project?, initialPrompt? }`)",
      );
      return;
    }
    // Well-formed but semantically refused: a non-prompting mode could never raise the awaiting-input
    // signal a remotely-driven UC2 session needs (SRV-C-003 launch half). Pre-check here for a precise
    // 400 (like the 501 launcher pre-check above) rather than let launchSession's throw fall into the
    // 502 catch below — a 502 would wrongly read as "the backend could not bring up a surface".
    if (isNonPromptingPermissionMode(options.permissionMode)) {
      writeError(res, 400, NON_PROMPTING_MODE_REFUSED);
      return;
    }
    try {
      const launched = await launchSession(state, options);
      writeJson(res, 201, toLaunchAcceptedWire(launched.attachment));
    } catch {
      // Every backend rejected (e.g. tmux absent and no fallback up): no surface could be
      // brought up. Surface a gateway error rather than a silent drop.
      writeError(res, 502, "ccctl: no launcher backend could bring up a session terminal");
    }
  });
}

/**
 * Tear down every launched terminal this server owns — invoked on shutdown alongside the
 * worker-channel and SSE teardown in `index.ts`. Best-effort and fire-and-forget: each
 * {@link LaunchedSession.close} is idempotent and swallows its own errors (a window the operator
 * already closed), so a stray reject here must never break `close()`. Clears the set so a second
 * shutdown is a no-op.
 */
export function closeLaunchedSessions(state: SessionLaunchState): void {
  for (const launched of state.launchedSessions) {
    void launched.close().catch(() => {
      // Swallow: teardown is best-effort; the terminal may already be gone.
    });
  }
  state.launchedSessions.clear();
}
