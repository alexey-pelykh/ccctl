// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/server` — the local server.
 *
 * Terminates the current Claude Code build's native `stream-json` control transport:
 * the **environments-bridge** flow (bridge-protocol §1–§5), conformed to the worker's
 * observed wire (issue #130).
 *
 *   - §1 **Environment register** — `POST /v1/environments/bridge` (account Bearer)
 *     mints an environment id (`{ environment_id }`, no work-poll token).
 *   - §2 **Session create** — `POST /v1/sessions` (account Bearer) creates a
 *     {@link Session}, AUTO-ENQUEUES its `session` work item (with a locally-minted
 *     work-secret) for the worker to poll, and returns `{ session_id }` (no `ws_url`).
 *   - §3 **Work delivery** — `GET /v1/environments/{env}/work/poll`, long-polled and
 *     carrying NO credential, delivering a SINGLE work item (or an empty body). After
 *     delivery the worker drives the item's lifecycle with
 *     `POST …/work/{workId}/{ack,heartbeat,stop}`, each acknowledged 200 (#154).
 *     §1–§3 live in `environments-bridge.ts`.
 *   - §4/§5 **Per-session worker channel** — HTTP + Server-Sent Events, rooted at
 *     `/v1/code/sessions/{id}/worker` ({@link matchWorkerRoute}): `register` mints a
 *     `worker_epoch`, a held-open `events/stream` is the server→worker downstream,
 *     `events` is the batched upstream (where turn output returns), the bare
 *     `…/worker` path is method-multiplexed (`GET` worker-state restore / `PUT` status
 *     gate, #154), plus `heartbeat` + `events/delivery`. Handled in `worker-channel.ts`.
 *
 * **Two-credential boundary (HARD, #130).** The account OAuth Bearer rides §1/§2 ONLY
 * and is a strict NON-PERSISTING pass-through — validated for receipt and dropped,
 * never captured into state, a response, or a log. The §3 poll carries no credential;
 * the §4/§5 channel is authorized (in the credentialed wave) by the per-session
 * ingress token the server minted into the work-secret, NEVER the account Bearer.
 *
 * **Browser-facing session namespace (#13, session-addressed by #20).** The UI transport
 * is per session: `GET /api/sessions` lists the tracked sessions and `POST /api/sessions`
 * LAUNCHES a fresh headful session via the injected launcher (#31 — `ui-session-launch.ts`),
 * which lists immediately as `registering` until its worker checks in over the bridge — or is
 * evicted, never left as a ghost, if it never does (#33 — `pending-launch.ts`);
 * `GET /api/sessions/{id}/events` subscribes to one session's Server-Sent Events stream (the
 * worker channel fans that session's upstream `worker/events` payloads (§5) out to ONLY
 * its subscribers); and `POST /api/sessions/{id}/command` steers that one session (the
 * server pushes it worker-ward as a `client_event` on the addressed session's downstream;
 * {@link CcctlServer.injectTurn} is the programmatic form). Naming the session in the URL
 * makes cross-wiring between sessions structurally impossible. Loopback UI ingress is
 * unauthenticated at this slice.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ENVIRONMENTS_BRIDGE_PATH,
  NO_OP_LOGGER,
  SESSIONS_PATH,
  type HostEndpoint,
  type Logger,
  type Session,
} from "@ccctl/core";
import {
  closeWorkerChannels,
  DEFAULT_SESSION_EVICTION_GRACE_MS,
  DEFAULT_SESSION_IDLE_THRESHOLD_MS,
  DEFAULT_WORKER_LIVENESS_INTERVAL_MS,
  handleWorkerDelivery,
  handleWorkerEvents,
  handleWorkerEventsStream,
  handleWorkerHeartbeat,
  handleWorkerRegister,
  handleWorkerStateRestore,
  handleWorkerStatus,
  hasLiveWorkerChannel,
  injectUserTurn,
  matchWorkerRoute,
  type WorkerChannelRecord,
} from "./worker-channel.js";
import {
  closeEventStreams,
  createSessionEventRelays,
  handleEventStream,
  type SessionEventRelays,
} from "./event-stream.js";
import { handleUiCommand } from "./ui-command.js";
import { handleSessionsList, matchUiSessionRoute } from "./ui-sessions.js";
import {
  DEFAULT_MAX_SESSIONS,
  handleSessionLaunch,
  launchSession as launchTrackedSession,
  releaseLaunchedSessions,
  type LaunchOutcome,
} from "./ui-session-launch.js";
import {
  handleSessionStop,
  stopSession as stopTrackedSession,
  type SessionStopOptions,
  type StopOutcomeWire,
} from "./ui-session-stop.js";
import { DEFAULT_REGISTRATION_TIMEOUT_MS, type PendingLaunch } from "./pending-launch.js";
// The §1 wire's own "is this a usable concurrent-session cap" guard, reused verbatim to validate this
// server's `maxSessions` (#36) — one rule for both caps rather than two that drift (bridge-wire.ts).
import { isPositiveInteger } from "./bridge-wire.js";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "./session-launcher.js";
import {
  reconcileRecordedLaunches,
  rehydrateRetainedSessions,
  type ProcessLivenessProbe,
  type RecordedLaunch,
} from "./session-reconcile.js";
import { writeError } from "./http-response.js";
import {
  DEFAULT_WORK_POLL_TIMEOUT_MS,
  handleEnvironmentRegister,
  handleSessionCreate,
  handleWorkLifecycle,
  handleWorkPoll,
  matchWorkLifecyclePath,
  matchWorkPollPath,
  settlePendingPolls,
  type EnvironmentRecord,
} from "./environments-bridge.js";
import {
  brandListenError,
  DEFAULT_HOST,
  LOCAL_SERVER_AUTH_ENV,
  requireLocalServerAuth,
  resolveBindHost,
  WILDCARD_BIND_HOST,
} from "./startup.js";

// Re-export the §2 session-create response wire boundary (the snake_case DTO +
// mapper, ADR-001 / #108) on the public surface, so a contract consumer — a future
// worker client — asserts against the PINNED wire type instead of re-transcribing
// its shape. The mapper and its exact serialized bytes are golden-tested in
// session-create-wire.test.ts.
export { toSessionCreateResponseWire, type SessionCreateResponseWire } from "./session-create-wire.js";

// The concrete structured-log sink (#61): the Node-adjacent writer half of the `@ccctl/core`
// {@link Logger} contract. The daemon injects `createJsonLineLogger()` via {@link ServerConfig.logger}
// to turn on the diagnostic trail; the `Logger` / `LogEvent` / `NO_OP_LOGGER` types live in `@ccctl/core`.
export { createJsonLineLogger, type LogLineWriter } from "./logger.js";

// Re-export the browser-facing session-namespace wire types (#20 list, #31 launch) on the
// public surface, for the SAME contract-consumer reason as the §2 session-create wire above:
// a UI client — the web UI, and now the `ccctl` CLI's launch/attach on-ramp (#38) — asserts
// against the PINNED camelCase projection instead of re-transcribing its shape, so a wire drift
// breaks the consumer's typecheck rather than silently mismatching at runtime. `SessionSummaryWire`
// is one entry of the `GET /api/sessions` list; `LaunchAcceptedWire` is the `POST /api/sessions`
// launch-accepted body; `SessionStopOptions` / `StopAcceptedWire` / `StopFailureWire` +
// `StopFailureCode` are the `POST /api/sessions/{id}/stop` bodies (#76) — re-exported ahead of their
// consumers because #77's stop button and `ccctl stop` are BOTH required to branch on the same typed
// `code` rather than on prose, which only a pinned type can hold them to. `SessionStopOptions` is
// the REQUEST half of that pair, and doubles as the parameter of the programmatic
// `CcctlServer.stopSession` below — a public method whose argument type a caller could not otherwise
// name. Defined + wire-tested in ui-sessions.ts / ui-session-launch.ts / ui-session-stop.ts.
export type { SessionSummaryWire } from "./ui-sessions.js";
export type { LaunchAcceptedWire } from "./ui-session-launch.js";
export type {
  SessionStopOptions,
  StopAcceptedWire,
  StopFailureCode,
  StopFailureWire,
  StopOutcomeWire,
} from "./ui-session-stop.js";

// …and the RUNTIME half of that same stop contract (#77): the guard and the pinned set. The type
// above says what a `code` IS; only the guard lets a consumer NARROW an arbitrary decoded body to
// one, which is exactly what reading a failure answer requires — `ccctl stop`'s reader takes a
// `unknown` off the wire and must fail closed on anything outside the set (an errno-bearing throw
// also carries a string `code`). Shipping the type without the guard left the consumer #76 named
// able to declare the contract but not to check it, so it would have had to re-transcribe the set
// as a local copy — the precise drift the type export exists to prevent. The launch twin already
// ships both halves for this reason (`isLaunchFailureCode` + `LAUNCH_FAILURE_CODES` above); this is
// that pair's missing mirror. A value export, since both ship runtime. Defined + unit-tested in
// ui-session-stop.ts.
export { isStopFailureCode, STOP_FAILURE_CODES } from "./ui-session-stop.js";

// Re-export the baseline startup guarantees (#14) on the public surface. The daemon
// (@ccctl/cli's `serve`) applies them before binding, and any embedder gets the same
// refuse-start-without-auth + localhost-bind baseline. Defined and unit-tested in
// startup.ts; resolveBindHost is ALSO applied internally by startServer below, so the
// localhost-bind guarantee holds on the programmatic bind path, not only the CLI edge (#58).
export { DEFAULT_HOST, LOCAL_SERVER_AUTH_ENV, requireLocalServerAuth, resolveBindHost, WILDCARD_BIND_HOST };

// Re-export the #57 config-file auth source that COMPLETES the refuse-start-without-auth
// guarantee above: the XDG-config path resolver, its named constants, and the injectable
// reader seam. Same contract-consumer reason as the sibling session-store path resolver —
// an embedder (or a test) can name exactly WHERE the daemon looks for the secret rather
// than re-transcribing the path. Defined and unit-tested in startup.ts.
export {
  CCCTL_CONFIG_DIR,
  LOCAL_SERVER_AUTH_FILE_NAME,
  resolveLocalServerAuthPath,
  XDG_CONFIG_HOME_ENV,
  type AuthFileReader,
} from "./startup.js";

// Re-export the session-launcher port (#28) on the public surface — the backend-agnostic
// contract for bringing up a headful, locally-attachable terminal session. The tmux (#29)
// and owned-pty (#30) backends implement it; a caller (the daemon) depends only on the
// port. Type-only: the interface ships no runtime, its backends do. Defined in
// session-launcher.ts.
export type {
  ISessionLauncher,
  SessionLaunchOptions,
  LaunchedSession,
  TerminalAttachment,
} from "./session-launcher.js";

// Re-export the SURFACE-LIVENESS contract (#35) on the public surface — the pinned reading every
// `LaunchedSession.liveness()` answers, plus its runtime guard and pinned set. Part of the PORT, so it
// ships for the same reason the port itself does: anything implementing `LaunchedSession` outside this
// package must be able to name what its probe returns. The safe-teardown RULE that decides by these
// readings (`releaseLaunchedSession` / `decideRelease` / `ReleaseDisposition`) stays INTERNAL — the
// server's own teardown paths are its only callers, exactly as the sibling pending-launch registry and
// the orphan-reaper keep their functions off this surface (a later need can add an export; un-shipping
// one is breaking). Ships runtime (the guard + the pinned set), so a value export alongside the type.
// Defined in session-launcher.ts; the rule is defined and unit-tested in session-release.ts.
export { isSurfaceLiveness, SURFACE_LIVENESS_READINGS, type SurfaceLiveness } from "./session-launcher.js";

// Re-export the TYPED launch-failure contract (#33) on the public surface — the pinned
// `LaunchFailureCode` union every failed `POST /api/sessions` answers, its runtime guard, and the
// `SessionLaunchError` the port's backends reject with. The SAME contract-consumer reason as the
// wire types above: the `ccctl` CLI (and a future web UI) branches on the `code` a failed launch
// carries — "that directory does not exist" vs "no backend is available" — so it must assert against
// the PINNED set rather than re-transcribe it (a drift then breaks the consumer's typecheck instead
// of silently falling through to a generic message). Ships runtime (the class + the guard + the
// pinned set), so a value export. Defined in session-launcher.ts; its wire projection
// (`LaunchFailureWire`) is exported below alongside the launch-accepted body.
export {
  isLaunchFailureCode,
  LAUNCH_FAILURE_CODES,
  SessionLaunchError,
  isSessionLaunchError,
  type LaunchFailureCode,
} from "./session-launcher.js";
export type { LaunchFailureWire, LaunchOutcome } from "./ui-session-launch.js";

// Re-export the launch cap's public constant (#36) — the default ceiling (8) on live sessions, past
// which a launch is refused `at-capacity`. A caller overrides it via ServerConfig.maxSessions;
// exported so it can name the default rather than re-hardcode 8, exactly as the sibling
// DEFAULT_REGISTRATION_TIMEOUT_MS below is. Defined and unit-tested in ui-session-launch.ts.
export { DEFAULT_MAX_SESSIONS } from "./ui-session-launch.js";

// Re-export the pending-launch registry's public constant (#33) — the default window a launched
// session may stay `registering` before it is evicted as a ghost. The daemon (and a test) overrides
// it via ServerConfig.registrationTimeoutMs; exported so a caller can name the default rather than
// re-hardcode 10_000. Defined and unit-tested in pending-launch.ts.
export { DEFAULT_REGISTRATION_TIMEOUT_MS } from "./pending-launch.js";

// Re-export the tmux launcher backend (#29) on the public surface — the PRIMARY
// ISessionLauncher backend: a `tmux new-window` surface an operator can `tmux attach` from a
// desk terminal and drive by hand. The daemon selects it as primary and falls back to the
// owned-pty backend (#30) when tmux is absent (a rejected `launch`). Unlike the type-only port
// above, this ships runtime (the factory), so it is a value export alongside its config types.
// Defined in session-launcher-tmux.ts.
export {
  createTmuxSessionLauncher,
  DEFAULT_TMUX_BIN,
  DEFAULT_TMUX_SESSION_NAME,
  DEFAULT_WORKER_WINDOW_NAME,
  type TmuxRunner,
  type WorkerCommandFactory,
  type TmuxSessionLauncherConfig,
} from "./session-launcher-tmux.js";

// Re-export the owned-pty launcher backend (#30) on the public surface — the PORTABLE FALLBACK
// ISessionLauncher backend: an owned `node-pty` running the patched `claude`, for environments where
// the tmux backend (#29) is unavailable. Its attachability is DEGRADED (TerminalAttachment.attachable
// = false), surfaced honestly to the operator rather than hidden. The daemon composes it BEHIND the
// tmux primary via createFallbackSessionLauncher (#31), so a "New session" lands on the pty when tmux
// rejects. Ships runtime (the factory + default spawner), so a value export alongside its config/seam
// types and geometry defaults. The shared `WorkerCommandFactory` seam is already re-exported above via
// the tmux backend. Defined in session-launcher-pty.ts.
export {
  createPtySessionLauncher,
  defaultPtySpawner,
  DEFAULT_PTY_TERM_NAME,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  DEGRADED_ATTACH_HINT,
  type OwnedPty,
  type PtySpawner,
  type PtySpawnOptions,
  type PtySessionLauncherConfig,
} from "./session-launcher-pty.js";

// Re-export the fallback launcher composite (#31) on the public surface. The daemon composes
// the primary tmux backend (#29) with any fallback (#30) behind ONE ISessionLauncher port via
// this, then injects the result as ServerConfig.launcher — so a "New session" request lands on
// whichever backend is available ("via the primary or fallback backend"). Defined in
// session-launcher-fallback.ts.
export { createFallbackSessionLauncher } from "./session-launcher-fallback.js";

// Re-export the single-file JSON-snapshot ISessionStore backend (#23) on the public surface —
// the concrete persistence the hub's session registry + unread queue survive a restart on
// (a `0600` snapshot at an XDG state path, no secrets at rest). `@ccctl/core` owns the
// runtime-agnostic ISessionStore CONTRACT (#22); this is its Node-coupled file backend, which
// the daemon selects and injects. Ships runtime (the factory + path resolver), so a value export
// alongside its named path/mode constants. Defined and unit-tested in session-store-file.ts.
export {
  CCCTL_STATE_DIR,
  createFileSessionStore,
  resolveSessionStorePath,
  SESSION_STORE_DIR_MODE,
  SESSION_STORE_FILE_MODE,
  SESSION_STORE_FILE_NAME,
  XDG_STATE_HOME_ENV,
} from "./session-store-file.js";

// Re-export the orphan-reaper's CALLER-FACING contract (#34) — the INPUTS to the across-restart
// reconciliation the daemon runs before serving, so a recorded launched-session handle whose surface died
// while the daemon was down is evicted and one still alive is retained/rehydrated. The `ccctl` CLI's
// `serve` composes those inputs (the recorded handles loaded from the store + a backend-specific liveness
// probe) and passes them as ServerConfig, depending on the pinned `LaunchMarker` / `RecordedLaunch` /
// `ProcessLivenessProbe` contract rather than re-transcribing it. `asLaunchMarker` ships runtime and is a
// value export because it is the ONE way to mint the branded marker — without it no caller could build a
// RecordedLaunch at all. The reconcile/rehydrate functions and their `ReconcileOutcome`/`ReconcileState`
// types stay INTERNAL: startServer runs them off ServerConfig and nothing outside calls them, exactly as
// the sibling pending-launch registry keeps trackPendingLaunch/claimPendingLaunch/PendingLaunchState off
// this surface (a later need can add an export; un-shipping one is breaking). Defined and unit-tested in
// session-reconcile.ts.
export {
  asLaunchMarker,
  type LaunchMarker,
  type ProcessLivenessProbe,
  type RecordedLaunch,
} from "./session-reconcile.js";

// Re-export per-device token minting (#74 QR-pair onboarding) + hashing (#84) on the public
// surface — the daemon (@ccctl/cli's `serve`) mints a token to encode into the pairing QR, and
// hashes a minted token into its at-rest form before persisting a paired device. The pure
// encode/redact contract (DeviceToken/DeviceTokenHash, buildPairingUrl, loggablePairingUrl) is
// @ccctl/core's; these are the two runtime-coupled pieces — the CSPRNG mint + the node:crypto
// digest. Ship runtime (the factories), so value exports alongside the byte-count/algorithm
// constants and the injectable randomness seam. Defined and unit-tested in device-pairing.ts.
export {
  DEVICE_TOKEN_BYTES,
  DEVICE_TOKEN_HASH_ALGORITHM,
  hashDeviceToken,
  mintDeviceToken,
  type RandomBytesSource,
} from "./device-pairing.js";

// Re-export the worker↔server TLS certificate-pinning mechanism (#59) on the public surface —
// the node:crypto SPKI reduction (computeSpkiPin, sibling to hashDeviceToken) and the pin guard
// the worker runs (assertPinnedServerKey / CertificatePinMismatchError). `@ccctl/core` owns the
// pure contract (the SpkiPin brand + the certificatePinMatches decision); these are the
// runtime-coupled pieces. Ship runtime (the guard + reducer + error), so value exports alongside
// the named hash-algorithm constant. Defined and unit-tested in certificate-pinning.ts. SCOPE:
// the mechanism now; the live loopback TLS handshake wiring lands with the real worker (#67).
export {
  assertPinnedServerKey,
  CertificatePinMismatchError,
  computeSpkiPin,
  SPKI_PIN_HASH_ALGORITHM,
} from "./certificate-pinning.js";

// Re-export the single-file JSON-snapshot IDeviceStore backend (#84) on the public surface — the
// concrete persistence the hub's paired-device registry survives a restart on (a `0600` snapshot
// at an XDG state path, no plaintext token at rest). `@ccctl/core` owns the runtime-agnostic
// IDeviceStore CONTRACT; this is its Node-coupled file backend, which the daemon selects and
// injects. Ships runtime (the factory + path resolver), so a value export alongside its named
// path/mode constants. Defined and unit-tested in device-store-file.ts.
export {
  createFileDeviceStore,
  DEVICE_STORE_DIR_MODE,
  DEVICE_STORE_FILE_MODE,
  DEVICE_STORE_FILE_NAME,
  resolveDeviceStorePath,
} from "./device-store-file.js";

/** Configuration for a ccctl server instance. */
export interface ServerConfig {
  /** Loopback port the local HTTP server binds to. `0` selects an ephemeral port. */
  port: number;
  /** Host to bind. Defaults to loopback so nothing is exposed off-box. */
  host?: string;
  /**
   * Long-poll hold (ms) before an empty `…/work/poll` answers with an empty body.
   * Defaults to {@link DEFAULT_WORK_POLL_TIMEOUT_MS}; a test passes a short value for
   * a deterministic timeout.
   */
  workPollTimeoutMs?: number;
  /**
   * Interval (ms) between the per-session downstream **liveness frames** (#166) that hold an
   * idle worker's held-open SSE past its ~45s liveness timeout. Defaults to
   * {@link DEFAULT_WORKER_LIVENESS_INTERVAL_MS} (20s, comfortably below the timeout); a test
   * passes a short value to exercise the timer deterministically.
   */
  workerLivenessIntervalMs?: number;
  /**
   * Grace window (ms) before a session whose worker downstream has gone null is closed and evicted
   * from the registry (#173). Defaults to {@link DEFAULT_SESSION_EVICTION_GRACE_MS} (30s). Eviction
   * is reconnect-safe: the downstream close only arms a check this long later, which evicts solely a
   * session that is still downstream-null AND heartbeat-stale (a genuine reconnect is retained). A
   * test passes a short value to exercise eviction deterministically.
   */
  sessionEvictionGraceMs?: number;
  /**
   * Threshold (ms) a session may stay continuously idle — observed `worker_status: idle`, still
   * heartbeat-live — before the server raises the "idle > X" informational event that names it (#41).
   * The config-time knob (#42): defaults to {@link DEFAULT_SESSION_IDLE_THRESHOLD_MS} (2 min),
   * deliberately well above the liveness/eviction windows so the nudge fires only after a genuine lull,
   * not after every turn settles. Activity — a status change off idle, or an injected turn — resets the
   * per-session timer.
   *
   * MUST be a positive integer (ms) when set — {@link startServer} REJECTS anything else rather than
   * degrading to the default, mirroring {@link ServerConfig.maxSessions}: a `NaN` (what `Number(…)` of an
   * unset/mistyped env var yields) or a non-positive value handed to `setTimeout` would fire the nudge
   * immediately and repeatedly instead of after the lull, so a bad override fails closed at boot rather
   * than silently misfiring. A test passes a short (positive-integer) value to exercise it deterministically.
   */
  sessionIdleThresholdMs?: number;
  /**
   * The session launcher a `POST /api/sessions` "New session" request runs (#31) to bring up a
   * headful, locally-attachable terminal running the patched `claude`. An injected
   * {@link ISessionLauncher} port — the daemon composes the primary tmux backend (#29) with any
   * fallback (#30) behind it (see `createFallbackSessionLauncher`). Absent → the server tracks
   * and relays sessions but cannot launch one; `POST /api/sessions` fails closed with a 501.
   */
  launcher?: ISessionLauncher;
  /**
   * Ceiling on how many sessions may be LIVE at once (#36) — a `POST /api/sessions` (or a
   * programmatic {@link CcctlServer.launchSession}) that would exceed it is refused with a typed
   * `at-capacity` {@link LaunchFailureCode} rather than spawning another terminal. Defaults to
   * {@link DEFAULT_MAX_SESSIONS} (8).
   *
   * Bounds a remotely-triggered launch loop: each launch spawns a real terminal on the host, so an
   * unbounded one exhausts it and kills the operator's own sessions (`SRV-B-003`). Counts ALL live
   * sessions — launched (#31) and UC1-attached alike — so the ceiling is on what the host is
   * actually carrying, not on what this server happened to start, plus any launch in flight (so a
   * concurrent burst is bounded, not just a sequential caller). A slot frees whenever a session ends,
   * and the next launch succeeds.
   *
   * MUST be a positive integer — {@link startServer} REJECTS on anything else rather than degrading
   * to the default. `NaN` in particular (what `Number(process.env.CCCTL_MAX_SESSIONS)` yields for an
   * unset or mistyped var) would make every `live >= cap` comparison false and silently disable the
   * cap altogether, so it is refused at the door: this is a safety ceiling, and it fails closed.
   *
   * Not to be confused with the §1 environment's own `max_sessions` (`EnvironmentRegisterRequestBody`)
   * — that is a ceiling an environment DECLARES about itself on the bridge wire; this is the one this
   * server ENFORCES on its own launches.
   *
   * Raise it on a host that can carry more; a test lowers it to exercise the refusal without
   * spawning eight of anything.
   */
  maxSessions?: number;
  /**
   * How long (ms) a LAUNCHED session may stay `registering` — up on its terminal but not yet
   * checked in over the bridge (§2) — before it is evicted as a ghost (#33): its session dropped
   * from the registry and its terminal closed, so a worker that never registers cannot leave an
   * orphaned process behind. Defaults to {@link DEFAULT_REGISTRATION_TIMEOUT_MS} (10s). A test
   * passes a short value to exercise eviction deterministically; a slow host can raise it.
   */
  registrationTimeoutMs?: number;
  /**
   * The launched-session handles a PREVIOUS daemon recorded, loaded on this start so the orphan-reaper
   * (#34) can reconcile them against live processes BEFORE serving: a recorded handle whose surface is
   * still alive is rehydrated into the registry, one whose surface died while the daemon was down is
   * evicted. Reconciliation is keyed on each handle's {@link RecordedLaunch.marker} (a durable
   * launch-marker, never a raw PID) and runs only when a {@link ServerConfig.livenessProbe} is also
   * configured — without a probe there is no way to tell alive from dead, and a reaper that cannot
   * verify does not resurrect. Absent (the default): nothing to reconcile — a fresh registry. Loading
   * these from the persisted store is the marker-persistence plumbing still deferred (session-reconcile.ts).
   */
  recordedLaunches?: readonly RecordedLaunch[];
  /**
   * The READ-ONLY liveness probe the orphan-reaper (#34) decides {@link ServerConfig.recordedLaunches}
   * by — given a handle's launch-marker, is the surface it names still up? Injected because "is this
   * process alive" is a backend-specific, host-touching question (the tmux backend answers it from one
   * `tmux list-windows`); a test passes a fake. It has no verb but liveness, so the reaper cannot kill a
   * live process (AC4). Absent (the default): the reaper does not run, and no recorded handle is rehydrated.
   */
  livenessProbe?: ProcessLivenessProbe;
  /**
   * The structured-log sink (#61) the daemon injects to turn on the diagnostic trail — session
   * lifecycle, bridge registration, worker-status detection, notification dispatch, and refusals,
   * enough to diagnose a stalled or leaked long-lived daemon. An injected {@link Logger} port, like
   * {@link ServerConfig.launcher} and {@link ServerConfig.livenessProbe}. Absent (the default): the
   * server falls back to {@link NO_OP_LOGGER} and emits nothing, so an embedder or a test that wants a
   * quiet server gets one. `@ccctl/server` ships {@link createJsonLineLogger} as the concrete writer.
   *
   * Redaction is a property of the {@link LogEvent} SHAPE, not of this sink: a {@link LogEvent} is
   * JSON-safe by construction and carries no field for the account Bearer or the session-ingress
   * token, so whatever writer is injected here cannot be handed a credential to leak.
   */
  logger?: Logger;
}

/** A running ccctl server: the relay between the environments-bridge worker and the UI. */
export interface CcctlServer {
  /**
   * The address the server actually bound. When {@link ServerConfig.port} is `0`
   * this carries the resolved ephemeral port — so callers can always learn where to
   * reach the server, and the base the work-secret's `api_base_url` points at.
   */
  readonly address: HostEndpoint;
  /** Sessions currently tracked by this server, keyed by ccctl session id. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Environments registered on this server (§1), keyed by environment id. */
  readonly environments: ReadonlyMap<string, EnvironmentRecord>;
  /**
   * Inject one user turn — push a `{ type: "user" }` `client_event` down the session's
   * held-open worker downstream (§4/§5). The programmatic form of the turn a
   * `POST /api/sessions/{id}/command` `prompt` drives. Throws if the session has no live worker channel
   * (guard the call with {@link CcctlServer.hasLiveWorker}).
   */
  injectTurn(sessionId: string, prompt: string): void;
  /**
   * Whether the session has a LIVE worker channel — a real worker registered AND is
   * holding its §4/§5 downstream open ({@link CcctlServer.injectTurn}'s precondition). The
   * receiver-grounded read of "a real worker is connected", distinct from the session
   * merely existing in {@link CcctlServer.sessions}; `false` for an unknown session or one
   * whose worker has not opened (or has closed) its downstream.
   */
  hasLiveWorker(sessionId: string): boolean;
  /**
   * Whether the session currently has a UI event **relay** in the registry — a per-session
   * SSE fan-out is created lazily on first UI subscribe / first worker-event broadcast, and
   * reaped when the session is evicted (#173/#176). The receiver-grounded read of "this
   * session's relay is still tracked", used to verify eviction reaps it and does not leak.
   */
  hasSessionRelay(sessionId: string): boolean;
  /**
   * Launch a fresh headful session (#31) via the configured {@link ServerConfig.launcher} and track
   * its terminal handle for shutdown teardown — the programmatic form of a `POST /api/sessions`
   * "New session" request. Resolves with the {@link LaunchOutcome}: the server-minted session id
   * and the {@link LaunchedSession} handle ({@link TerminalAttachment} + `close`).
   *
   * The launched session is in {@link CcctlServer.sessions} the moment this resolves — as
   * `registering` (#33), not as a live session: its terminal is up but its worker has not checked
   * in yet. It then either registers over the bridge (§2), advancing IN PLACE on the same id to
   * `connecting`, or fails to and is EVICTED after {@link ServerConfig.registrationTimeoutMs} — its
   * session dropped and its terminal closed, never left behind as a ghost.
   *
   * Rejects with a {@link SessionLaunchError} carrying a {@link LaunchFailureCode}: no launcher
   * configured, a non-prompting permission-mode, a `cwd` that is not an existing directory, or a
   * launcher that could bring up no surface. A failed launch touches no state at all.
   */
  launchSession(options: SessionLaunchOptions): Promise<LaunchOutcome>;
  /**
   * EMERGENCY-STOP one session (#76) — kill the terminal this server launched it on and drive the
   * session to its terminal state. The programmatic form of a `POST /api/sessions/{id}/stop`, and the
   * same shared core, so this cannot stop a session the HTTP path would refuse (nor the reverse).
   *
   * Resolves with what the stop did — `stopped` (this server killed the surface) or `already-exited`
   * (it was already gone) — plus the terminal {@link Session} it produced. On both, the session has
   * left {@link CcctlServer.sessions} and its UI relay is reaped, so a slot frees under the
   * `maxSessions` cap.
   *
   * Rejects with a {@link SessionStopError} carrying a {@link StopFailureCode} on every path that did
   * NOT stop the session: no such session (`unknown-session`); this server never launched it, so it
   * holds no handle to kill (`no-surface` — a UC1 attach); the operator has taken the surface over and
   * `force` was not given (`taken-over`, the AC3 envelope); the terminal may be running another
   * session's live worker (`ambiguous-surface`, which `force` deliberately does NOT override); the
   * backend could not read the surface (`liveness-unknown`); or the teardown itself failed
   * (`stop-failed`).
   *
   * A REFUSED stop touches no state — the session stays exactly as it was, which is what makes a
   * refusal safe to retry. The one exception is `unknown-session` raised at the END rather than the
   * gate: an eviction reaped the session while this stop was probing its surface, so the retirement
   * had already begun. Nothing there is wrong or worth undoing — the operator asked for the session to
   * be over and it is over, by another hand — but the same operator action can answer `already-exited`
   * or `unknown-session` depending on which of the two got there first.
   *
   * `force` (default `false`) authorizes killing a session the OPERATOR has taken over, and only that
   * — it is the explicit consent AC3 requires, and it is scoped to the session named here.
   */
  stopSession(
    sessionId: string,
    options?: SessionStopOptions,
  ): Promise<{ readonly outcome: StopOutcomeWire; readonly session: Session }>;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** Mutable per-server state shared with the request handler and the bridge legs. */
interface ServerState {
  readonly sessions: Map<string, Session>;
  /** Environments registered via §1, keyed by environment id (owns the §3 work queue). */
  readonly environments: Map<string, EnvironmentRecord>;
  /** The live per-session worker channel (§4/§5): epoch + held-open downstream + seq. */
  readonly workerChannels: Map<string, WorkerChannelRecord>;
  /** The per-session UI Server-Sent Events relays — each session its own subscribers + replay buffer. */
  readonly eventRelays: SessionEventRelays;
  /** The injected session launcher (#31), or `undefined` when this server was configured without one. */
  readonly launcher: ISessionLauncher | undefined;
  /**
   * Handles to the terminals this server launched (#31), keyed by the session id each was launched
   * for — tracked so shutdown tears them down, and keyed so an emergency-stop can address ONE
   * session's terminal (#76). See {@link PendingLaunchState.launchedSurfaces} for why the key is the
   * launch-minted id and why an entry may outlive its session's row.
   */
  readonly launchedSurfaces: Map<string, LaunchedSession>;
  /**
   * Ceiling on live sessions (#36) — a launch past it is refused `at-capacity`. Counts `sessions`
   * plus `launchReservations`. Validated at {@link startServer}, so it is always a positive integer.
   */
  readonly maxSessions: number;
  /** Slots held by in-flight launches (#36) — taken before the launcher runs, released when it settles. */
  readonly launchReservations: Set<symbol>;
  /**
   * Launches awaiting their worker's registration (#33), keyed by the session id minted at launch —
   * each holding its terminal handle and an armed eviction timer. A launch adds one; the §2
   * registration claims it, or the timer evicts it. Empty in the steady state.
   */
  readonly pendingLaunches: Map<string, PendingLaunch>;
  /** How long a launched session may stay `registering` before it is evicted as a ghost (ms, #33). */
  readonly registrationTimeoutMs: number;
  /** Long-poll hold (ms) for an empty `…/work/poll`. */
  readonly workPollTimeoutMs: number;
  /** Interval (ms) between per-session downstream liveness frames (§4/§5, #166). */
  readonly workerLivenessIntervalMs: number;
  /** Grace window (ms) before a downstream-null, heartbeat-stale session is closed + evicted (#173). */
  readonly sessionEvictionGraceMs: number;
  /** Threshold (ms) a session may stay continuously idle before the "idle > X" event is raised (#41). */
  readonly sessionIdleThresholdMs: number;
  /** The structured-log sink (#61) — {@link ServerConfig.logger}, or {@link NO_OP_LOGGER} when absent. Threaded to every handler slice that emits a diagnostic event. */
  readonly logger: Logger;
  /** Provisional at construction; finalized with the resolved port once bound. */
  address: HostEndpoint;
}

/**
 * Route one HTTP request. The browser-facing session namespace is matched first
 * (`GET /api/sessions` list, `GET /api/sessions/{id}/events` view, `POST
 * /api/sessions/{id}/command` steer — all session-addressed, #20), then the
 * environments-bridge legs (§1 environment register, §2 session create, §3 work poll
 * and the `…/work/{workId}/{ack,heartbeat,stop}` lifecycle verbs, #154) and the §4/§5
 * per-session worker channel (whose bare `…/worker` path is method-multiplexed —
 * GET worker-state restore / PUT status gate, #154). Anything else falls through to a
 * fail-closed 404.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const uiSession = matchUiSessionRoute(pathname);
  if (uiSession !== null) {
    switch (uiSession.kind) {
      case "list":
        // The `/api/sessions` collection: POST LAUNCHES a new session (#31), GET LISTS them.
        // Each handler owns its own method guard (a non-GET falls through to the list's 405).
        if (req.method === "POST") {
          handleSessionLaunch(req, res, state);
        } else {
          handleSessionsList(req, res, state);
        }
        return;
      case "events":
        handleEventStream(req, res, state, uiSession.sessionId);
        return;
      case "command":
        handleUiCommand(req, res, state, uiSession.sessionId);
        return;
      case "stop":
        handleSessionStop(req, res, state, uiSession.sessionId);
        return;
    }
  }
  if (pathname === ENVIRONMENTS_BRIDGE_PATH) {
    handleEnvironmentRegister(req, res, state);
    return;
  }
  // §2 session create is matched EXACTLY (`POST /v1/sessions`); the speculative attach-side
  // `GET /v1/sessions/{id}` #154 flagged ("Likely also applies…", empty 200 tolerated) is
  // intentionally NOT routed — an id-suffixed path falls through to the fail-closed 404 below.
  // Confirmed against the e2e captured-wire golden (bridge-wire-conformance.ts, #131/#155) and
  // the live-worker oracle (live-worker-oracle.ts): a real worker's attach/restore is the §4/§5
  // worker channel `GET /v1/code/sessions/{id}/worker`, never a bare session-resource GET (#165).
  if (pathname === SESSIONS_PATH) {
    handleSessionCreate(req, res, state);
    return;
  }
  const workEnvironmentId = matchWorkPollPath(pathname);
  if (workEnvironmentId !== null) {
    handleWorkPoll(req, res, state, workEnvironmentId);
    return;
  }
  const workLifecycle = matchWorkLifecyclePath(pathname);
  if (workLifecycle !== null) {
    handleWorkLifecycle(req, res, state, workLifecycle);
    return;
  }
  const worker = matchWorkerRoute(pathname);
  if (worker !== null) {
    switch (worker.leg) {
      case "register":
        handleWorkerRegister(req, res, state, worker.sessionId);
        return;
      case "events-stream":
        handleWorkerEventsStream(req, res, state, worker.sessionId);
        return;
      case "events":
        handleWorkerEvents(req, res, state, worker.sessionId);
        return;
      case "events-delivery":
        handleWorkerDelivery(req, res, state, worker.sessionId);
        return;
      case "heartbeat":
        handleWorkerHeartbeat(req, res, state, worker.sessionId);
        return;
      case "status":
        // The bare `…/worker` path is method-multiplexed (#154): GET restores worker
        // state (empty 200), PUT is the status gate. Each handler owns its own guard.
        if (req.method === "GET") {
          handleWorkerStateRestore(req, res, state, worker.sessionId);
        } else {
          handleWorkerStatus(req, res, state, worker.sessionId);
        }
        return;
    }
  }
  writeError(res, 404, `ccctl: no route for ${pathname}`);
}

/** Assemble the public {@link CcctlServer} handle over a bound HTTP server. */
function createHandle(httpServer: Server, state: ServerState): CcctlServer {
  return {
    address: state.address,
    sessions: state.sessions,
    environments: state.environments,
    injectTurn(sessionId: string, prompt: string): void {
      injectUserTurn(state, sessionId, prompt);
    },
    hasLiveWorker(sessionId: string): boolean {
      return hasLiveWorkerChannel(state, sessionId);
    },
    hasSessionRelay(sessionId: string): boolean {
      return state.eventRelays.has(sessionId);
    },
    launchSession(options: SessionLaunchOptions): Promise<LaunchOutcome> {
      return launchTrackedSession(state, options);
    },
    stopSession(
      sessionId: string,
      options: SessionStopOptions = { force: false },
    ): Promise<{ readonly outcome: StopOutcomeWire; readonly session: Session }> {
      // Defaulted, not required, so the non-destructive stop is the one a caller gets for free and
      // force is a thing they had to type — the same default the HTTP body's absent `force` takes.
      return stopTrackedSession(state, sessionId, options);
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        // Settle any held work-polls (§3 long-poll). A poll held open on an empty
        // queue is an in-flight request `close()` waits on and an armed timer that
        // keeps the loop alive — without this, shutting down while a worker is
        // mid-poll hangs for up to workPollTimeoutMs. Same rationale as the SSE
        // teardown below.
        settlePendingPolls(state);
        // End open SSE streams — every session's UI relay (`/api/sessions/{id}/events`)
        // and every held-open worker downstream (`worker/events/stream`). An SSE response
        // holds its connection open indefinitely and is never "idle", so
        // `closeIdleConnections()` below would leave it and `close()` would hang waiting on it.
        closeEventStreams(state.eventRelays);
        closeWorkerChannels(state);
        // Release every terminal this server launched (#31) — each surface is PROBED and torn down
        // only if it is still server-owned (#35), so shutting the daemon down never kills a session
        // the operator took over at their desk; a taken-over one is left running for them. This also
        // disarms any pending registration-eviction timer (#33), so a launch still registering at
        // shutdown neither holds the loop open nor fires against a dead server's state.
        releaseLaunchedSessions(state);
        // Release idle keep-alive HTTP sockets so a quiescent server closes promptly
        // instead of waiting on pooled client connections.
        httpServer.closeIdleConnections();
      });
    },
  };
}

/**
 * Start the local relay server. Resolves once it is listening, with a
 * {@link CcctlServer} whose {@link CcctlServer.address} reports the bound host and
 * (possibly ephemeral) port. Rejects if the socket fails to bind.
 */
export function startServer(config: ServerConfig): Promise<CcctlServer> {
  // The structured-log sink (#61), resolved once at the top so the BOOT refusals below — which reject
  // before any `state` exists — share the same trail as every later runtime event. Absent → the no-op
  // sink, so an unconfigured server stays silent.
  const logger = config.logger ?? NO_OP_LOGGER;
  // Localhost-bind guarantee (#58), enforced on the ACTUAL bind path so it is not silently
  // overridable: an embedder passing a non-loopback `config.host` (`0.0.0.0`, `::`, a LAN or public
  // IP) is refused HERE, exactly as `ccctl serve` refuses one at the CLI edge — the guarantee holds
  // on every start path, not only through the daemon binary. `resolveBindHost` also supplies the
  // loopback DEFAULT when `config.host` is absent (and refuses an empty-string host, which the prior
  // `config.host ?? DEFAULT_HOST` silently let through). It THROWS on a non-loopback host; convert
  // that to a REJECTION so this promise-returning entry point fails one way, always — the same
  // mixed-contract footgun the maxSessions guard below avoids: `startServer(cfg).catch(…)` must catch
  // a refused bind just as it catches a bad cap.
  let host: string;
  try {
    host = resolveBindHost(config.host);
  } catch (error) {
    // resolveBindHost throws an Error; re-narrow the `unknown` catch binding to one so the
    // rejection reason is statically an Error (and stays robust if that ever changes).
    const reason = error instanceof Error ? error : new Error(String(error));
    logger.log({ category: "error", level: "error", event: "bind-refused", sessionId: null, detail: reason.message });
    return Promise.reject(reason);
  }
  // Refuse a nonsense session cap AT BOOT, before anything binds (#36). `??` only defends against an
  // absent value, and the values it lets through are not all harmless: `NaN` — trivially produced by
  // the very `Number(process.env.…)` an embedder writes to honor the cap's config-overridability —
  // makes `live >= cap` ALWAYS FALSE, so the guard silently never fires. A safety cap that fails OPEN
  // is worse than none: it reports a bound it is not enforcing. A negative or fractional cap is
  // likewise a mistake, not an intent. So this fails CLOSED and LOUDLY, in the one place the number
  // enters the server, rather than degrading to the default — an operator who asked for a specific
  // cap and silently got 8 has been told nothing, and would find out by watching a loop run.
  //
  // REJECTED, not thrown: this function's contract is to return a promise, and it already rejects for
  // the other way a start can fail (`brandListenError` below). A synchronous throw out of a
  // promise-returning function is the classic mixed-contract footgun — `startServer(cfg).catch(…)`
  // would not catch it — so the one entry point answers its caller one way, always.
  if (config.maxSessions !== undefined && !isPositiveInteger(config.maxSessions)) {
    const reason = new Error(
      `ccctl: maxSessions must be a positive integer (got \`${String(config.maxSessions)}\`) — ` +
        "it is the ceiling on live sessions, and a cap that is not a counting number cannot bound anything",
    );
    logger.log({ category: "error", level: "error", event: "boot-rejected", sessionId: null, detail: reason.message });
    return Promise.reject(reason);
  }
  // The idle-threshold config-time override (#42) fails closed the same way maxSessions does: a `NaN`
  // (what `Number(…)` of an unset/mistyped env var yields) or a non-positive value handed to `setTimeout`
  // would fire the "idle > X" nudge immediately and repeatedly rather than after the lull, so a mistyped
  // override is refused at the door instead of silently defeating the timer.
  if (config.sessionIdleThresholdMs !== undefined && !isPositiveInteger(config.sessionIdleThresholdMs)) {
    const reason = new Error(
      `ccctl: sessionIdleThresholdMs must be a positive integer (got \`${String(config.sessionIdleThresholdMs)}\`) — ` +
        "it is the ms a session may sit idle before the nudge, and a non-positive/NaN value would fire it immediately, not after the lull",
    );
    logger.log({ category: "error", level: "error", event: "boot-rejected", sessionId: null, detail: reason.message });
    return Promise.reject(reason);
  }
  const state: ServerState = {
    sessions: new Map<string, Session>(),
    environments: new Map<string, EnvironmentRecord>(),
    workerChannels: new Map<string, WorkerChannelRecord>(),
    eventRelays: createSessionEventRelays(),
    launcher: config.launcher,
    launchedSurfaces: new Map<string, LaunchedSession>(),
    maxSessions: config.maxSessions ?? DEFAULT_MAX_SESSIONS,
    launchReservations: new Set<symbol>(),
    pendingLaunches: new Map<string, PendingLaunch>(),
    registrationTimeoutMs: config.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
    workPollTimeoutMs: config.workPollTimeoutMs ?? DEFAULT_WORK_POLL_TIMEOUT_MS,
    workerLivenessIntervalMs: config.workerLivenessIntervalMs ?? DEFAULT_WORKER_LIVENESS_INTERVAL_MS,
    sessionEvictionGraceMs: config.sessionEvictionGraceMs ?? DEFAULT_SESSION_EVICTION_GRACE_MS,
    sessionIdleThresholdMs: config.sessionIdleThresholdMs ?? DEFAULT_SESSION_IDLE_THRESHOLD_MS,
    logger,
    address: { host, port: config.port },
  };

  // Orphan-reaper (#34): BEFORE the listener opens, reconcile the handles a previous daemon recorded
  // launching against the surfaces still live on this host — one that outlived the daemon (a tmux window
  // the operator may have taken over) is rehydrated into the registry, one that died while the daemon was
  // down is evicted. Records only: the probe is read-only, so no live process is ever killed. Runs
  // synchronously here, ahead of createServer/listen, so the registry is reconciled before the server can
  // answer a single request (AC1/AC5). Gated on a probe being configured — without one, alive cannot be
  // told from dead, so nothing is rehydrated (a reaper that cannot verify does not resurrect). A no-op on
  // a fresh daemon and until the marker-persistence that FILLS recordedLaunches lands (session-reconcile.ts).
  if (config.livenessProbe !== undefined) {
    const { retained } = reconcileRecordedLaunches(config.recordedLaunches ?? [], config.livenessProbe);
    rehydrateRetainedSessions(state, retained);
  }

  const httpServer = createServer((req, res) => {
    try {
      handleRequest(req, res, state);
    } catch {
      if (!res.headersSent) {
        writeError(res, 500, "ccctl: internal server error");
      }
    }
  });

  return new Promise<CcctlServer>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      // Rebrand a "port already in use" failure into an actionable ccctl: guardrail
      // message (#156); any other listen error passes through unchanged. The CLI
      // prints error.message (never the stack) and exits non-zero, so branding here
      // is the whole user-visible fix.
      const reason = brandListenError(error, config.port);
      logger.log({
        category: "error",
        level: "error",
        event: "listen-failed",
        sessionId: null,
        detail: reason.message,
      });
      reject(reason);
    };
    httpServer.once("error", onListenError);
    httpServer.listen(config.port, host, () => {
      httpServer.removeListener("error", onListenError);
      const bound = httpServer.address();
      if (typeof bound === "object" && bound !== null) {
        state.address = { host, port: bound.port };
      }
      resolve(createHandle(httpServer, state));
    });
  });
}
